"""Draft + send + schedule API for outbound channel messages."""
from __future__ import annotations

import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..agents import refine_draft, stream_draft_pipeline
from ..db import get_db
from ..integrations.slack import SlackClient, SlackError
from ..ws_manager import manager

log = logging.getLogger(__name__)

router = APIRouter(prefix="/drafts", tags=["drafts"])


# ---------- read ----------


@router.get("", response_model=list[schemas.DraftOut])
def list_drafts(
    channel_pk: int | None = None,
    status: str | None = None,
    db: Session = Depends(get_db),
):
    q = db.query(models.MessageDraft).order_by(models.MessageDraft.created_at.desc())
    if channel_pk is not None:
        q = q.filter(models.MessageDraft.channel_pk == channel_pk)
    if status:
        q = q.filter(models.MessageDraft.status == status)
    return q.limit(100).all()


@router.get("/{draft_id}", response_model=schemas.DraftOut)
def get_draft(draft_id: int, db: Session = Depends(get_db)):
    d = db.get(models.MessageDraft, draft_id)
    if not d:
        raise HTTPException(404, "Draft not found")
    return d


# ---------- create / update ----------


@router.post("", response_model=schemas.DraftOut)
def create_draft(payload: schemas.DraftCreateIn, db: Session = Depends(get_db)):
    ch = db.get(models.SlackChannel, payload.channel_pk)
    if not ch:
        raise HTTPException(404, "Channel not found")
    d = models.MessageDraft(
        channel_pk=payload.channel_pk,
        body=payload.body,
        source_summary=payload.source_summary,
        scheduled_for=payload.scheduled_for,
        status="scheduled" if payload.scheduled_for else "draft",
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


@router.patch("/{draft_id}", response_model=schemas.DraftOut)
def update_draft(draft_id: int, payload: schemas.DraftUpdateIn, db: Session = Depends(get_db)):
    d = db.get(models.MessageDraft, draft_id)
    if not d:
        raise HTTPException(404, "Draft not found")
    if d.status not in ("draft", "scheduled"):
        raise HTTPException(400, f"Cannot edit a {d.status} draft")
    if payload.body is not None:
        d.body = payload.body
    if payload.unschedule:
        d.scheduled_for = None
        d.status = "draft"
    elif payload.scheduled_for is not None:
        d.scheduled_for = payload.scheduled_for
        d.status = "scheduled"
    db.commit()
    db.refresh(d)
    return d


@router.delete("/{draft_id}", status_code=204)
def delete_draft(draft_id: int, db: Session = Depends(get_db)):
    d = db.get(models.MessageDraft, draft_id)
    if not d:
        raise HTTPException(404, "Draft not found")
    db.delete(d)
    db.commit()


# ---------- AI draft pipeline (LangGraph) ----------


@router.post("/from-channel/{channel_pk}/stream")
async def draft_from_channel_stream(
    channel_pk: int,
    payload: schemas.DraftFromChannelIn,
    db: Session = Depends(get_db),
):
    """Run the summarize -> draft pipeline and stream tokens as SSE.

    On completion, persists a new MessageDraft row and emits a 'saved' event
    with its id so the client can edit / schedule / send it.
    """
    ch = db.get(models.SlackChannel, channel_pk)
    if not ch:
        raise HTTPException(404, "Channel not found")
    rows = (
        db.query(models.SlackMessage)
        .filter(models.SlackMessage.channel_pk == channel_pk)
        .order_by(models.SlackMessage.ts.desc())
        .limit(payload.message_limit)
        .all()
    )
    formatted = [
        {"user": m.user_name or m.user_id or "unknown", "text": m.text}
        for m in reversed(rows)
    ]
    channel_name = ch.name

    async def gen():
        summary_text = ""
        draft_text = ""
        try:
            async for kind, value in stream_draft_pipeline(channel_name, formatted, payload.intent or ""):
                if kind == "summary_chunk":
                    summary_text += value  # type: ignore[operator]
                    yield f"event: summary_chunk\ndata: {json.dumps({'text': value})}\n\n"
                elif kind == "draft_chunk":
                    draft_text += value  # type: ignore[operator]
                    yield f"event: draft_chunk\ndata: {json.dumps({'text': value})}\n\n"
                elif kind == "phase":
                    yield f"event: phase\ndata: {json.dumps({'phase': value})}\n\n"
                elif kind == "done":
                    summary_text = value["summary"] or summary_text  # type: ignore[index]
                    draft_text = value["draft"] or draft_text  # type: ignore[index]
        except Exception as e:  # noqa: BLE001
            log.exception("draft pipeline failed")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
            return

        if draft_text:
            d = models.MessageDraft(
                channel_pk=channel_pk,
                body=draft_text,
                source_summary=summary_text,
                status="draft",
            )
            db.add(d)
            db.commit()
            db.refresh(d)
            yield f"event: saved\ndata: {json.dumps({'id': d.id, 'body': d.body})}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/{draft_id}/refine", response_model=schemas.DraftOut)
async def refine(draft_id: int, payload: schemas.RefineIn, db: Session = Depends(get_db)):
    d = db.get(models.MessageDraft, draft_id)
    if not d:
        raise HTTPException(404, "Draft not found")
    if d.status not in ("draft", "scheduled"):
        raise HTTPException(400, f"Cannot refine a {d.status} draft")
    ch = db.get(models.SlackChannel, d.channel_pk)
    new_body = await refine_draft(
        ch.name if ch else "channel",
        d.source_summary or "",
        d.body,
        payload.instruction,
    )
    if new_body:
        d.body = new_body
        db.commit()
        db.refresh(d)
    return d


# ---------- send ----------


async def _send_draft_via_slack(db: Session, draft: models.MessageDraft) -> models.MessageDraft:
    ch = db.get(models.SlackChannel, draft.channel_pk)
    if not ch:
        draft.status = "failed"
        draft.error = "channel missing"
        db.commit()
        raise HTTPException(404, "Channel not found")
    acc = db.get(models.SlackAccount, ch.account_id)
    if not acc:
        draft.status = "failed"
        draft.error = "account missing"
        db.commit()
        raise HTTPException(404, "Account not found")
    client = SlackClient(acc.access_token)
    try:
        result = await client.post_message(ch.channel_id, draft.body)
        draft.status = "sent"
        draft.sent_at = datetime.utcnow()
        draft.sent_ts = result.get("ts")
        draft.scheduled_for = None
        draft.error = None
        db.commit()
        db.refresh(draft)
        await manager.broadcast({
            "type": "draft.sent",
            "draft_id": draft.id,
            "channel_pk": draft.channel_pk,
            "sent_ts": draft.sent_ts,
        })
        return draft
    except SlackError as e:
        draft.status = "failed"
        draft.error = str(e)
        db.commit()
        await manager.broadcast({
            "type": "draft.failed",
            "draft_id": draft.id,
            "channel_pk": draft.channel_pk,
            "error": str(e),
        })
        raise HTTPException(502, f"Slack: {e}")
    finally:
        await client.aclose()


@router.post("/{draft_id}/send", response_model=schemas.DraftOut)
async def send_now(draft_id: int, db: Session = Depends(get_db)):
    d = db.get(models.MessageDraft, draft_id)
    if not d:
        raise HTTPException(404, "Draft not found")
    if d.status not in ("draft", "scheduled"):
        raise HTTPException(400, f"Cannot send a {d.status} draft")
    if not d.body.strip():
        raise HTTPException(400, "Draft body is empty")
    return await _send_draft_via_slack(db, d)


@router.post("/quick-send")
async def quick_send(payload: schemas.QuickSendIn, db: Session = Depends(get_db)):
    """Send a one-off message without persisting a draft row."""
    if not payload.body.strip():
        raise HTTPException(400, "Body is empty")
    ch = db.get(models.SlackChannel, payload.channel_pk)
    if not ch:
        raise HTTPException(404, "Channel not found")
    acc = db.get(models.SlackAccount, ch.account_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    client = SlackClient(acc.access_token)
    try:
        result = await client.post_message(ch.channel_id, payload.body)
        return {"ok": True, "ts": result.get("ts")}
    except SlackError as e:
        raise HTTPException(502, f"Slack: {e}")
    finally:
        await client.aclose()
