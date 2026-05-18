from __future__ import annotations

import json
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse, StreamingResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import settings
from ..db import get_db
from ..integrations.slack import SlackClient, SlackError, exchange_oauth_code
from ..llm import stream_summary, summarize_messages

router = APIRouter(prefix="/slack", tags=["slack"])

OAUTH_SCOPES = "channels:history,channels:read,chat:write,groups:history,groups:read,im:history,im:read,im:write,users:read"


@router.get("/accounts", response_model=list[schemas.AccountOut])
def list_accounts(db: Session = Depends(get_db)):
    return db.query(models.SlackAccount).all()


@router.get("/channels", response_model=list[schemas.ChannelOut])
def list_channels(account_id: int | None = None, db: Session = Depends(get_db)):
    q = db.query(models.SlackChannel)
    if account_id is not None:
        q = q.filter(models.SlackChannel.account_id == account_id)
    return q.order_by(models.SlackChannel.name).all()


@router.get("/channels/{channel_pk}/messages", response_model=list[schemas.MessageOut])
def list_messages(channel_pk: int, limit: int = 50, db: Session = Depends(get_db)):
    channel = db.get(models.SlackChannel, channel_pk)
    if not channel:
        raise HTTPException(404, "Channel not found")
    return (
        db.query(models.SlackMessage)
        .filter(models.SlackMessage.channel_pk == channel_pk)
        .order_by(models.SlackMessage.ts.desc())
        .limit(limit)
        .all()
    )


def _load_for_summary(channel_pk: int, limit: int, db: Session):
    channel = db.get(models.SlackChannel, channel_pk)
    if not channel:
        raise HTTPException(404, "Channel not found")
    messages = (
        db.query(models.SlackMessage)
        .filter(models.SlackMessage.channel_pk == channel_pk)
        .order_by(models.SlackMessage.ts.desc())
        .limit(limit)
        .all()
    )
    formatted = [
        {"user": m.user_name or m.user_id or "unknown", "text": m.text}
        for m in reversed(messages)
    ]
    return channel.channel_id, channel.name, formatted, len(messages)


@router.post("/channels/{channel_pk}/summary", response_model=schemas.SummaryOut)
async def summarize_channel(channel_pk: int, limit: int = 50, db: Session = Depends(get_db)):
    channel_id, name, formatted, count = _load_for_summary(channel_pk, limit, db)
    if count == 0:
        return schemas.SummaryOut(channel_id=channel_id, summary="No messages to summarize.", message_count=0)
    summary = await summarize_messages(name, formatted)
    return schemas.SummaryOut(channel_id=channel_id, summary=summary, message_count=count)


@router.get("/channels/{channel_pk}/summary/stream")
async def summarize_channel_stream(channel_pk: int, limit: int = 50, db: Session = Depends(get_db)):
    """Stream the summary as Server-Sent Events so the UI can render it live."""
    channel_id, name, formatted, count = _load_for_summary(channel_pk, limit, db)

    async def gen():
        yield f"event: meta\ndata: {json.dumps({'channel_id': channel_id, 'message_count': count})}\n\n"
        try:
            async for chunk in stream_summary(name, formatted):
                yield f"event: chunk\ndata: {json.dumps({'text': chunk})}\n\n"
            yield "event: done\ndata: {}\n\n"
        except Exception as e:  # noqa: BLE001 — surface error to client
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ---------- OAuth flow (only used if SLACK_CLIENT_ID/SECRET are set) ----------


@router.get("/auth/install")
def install():
    if not settings.slack_client_id:
        raise HTTPException(400, "SLACK_CLIENT_ID not configured. Use SLACK_TOKEN env var instead, or set up an app at api.slack.com/apps.")
    qs = urlencode({
        "client_id": settings.slack_client_id,
        "scope": OAUTH_SCOPES,
        "redirect_uri": settings.slack_redirect_uri,
    })
    return RedirectResponse(f"https://slack.com/oauth/v2/authorize?{qs}")


@router.get("/auth/callback")
async def callback(code: str = Query(...), db: Session = Depends(get_db)):
    if not settings.slack_client_id or not settings.slack_client_secret:
        raise HTTPException(400, "OAuth not configured")
    try:
        data = await exchange_oauth_code(
            settings.slack_client_id, settings.slack_client_secret, code, settings.slack_redirect_uri
        )
    except SlackError as e:
        raise HTTPException(400, f"Slack OAuth failed: {e}")

    team = data.get("team", {})
    access_token = data.get("access_token") or data.get("authed_user", {}).get("access_token")
    token_type = "bot" if data.get("access_token") else "user"
    if not access_token or not team.get("id"):
        raise HTTPException(400, "Slack response missing access_token or team")

    existing = db.query(models.SlackAccount).filter_by(team_id=team["id"]).first()
    if existing:
        existing.access_token = access_token
        existing.token_type = token_type
        existing.team_name = team.get("name", existing.team_name)
    else:
        db.add(models.SlackAccount(
            team_id=team["id"],
            team_name=team.get("name", "Unknown"),
            access_token=access_token,
            token_type=token_type,
            authed_user_id=data.get("authed_user", {}).get("id"),
        ))
    db.commit()
    return RedirectResponse(settings.frontend_origin)


# ---------- Manual sync trigger ----------


@router.post("/sync")
async def sync_now(db: Session = Depends(get_db)):
    """Force an immediate poll cycle (useful while developing)."""
    from ..poller import poll_once
    result = await poll_once(db)
    return result
