"""Tools the assistant agent can call.

Each tool opens its own DB session, does the work, and returns a JSON-encoded
string (LangChain tools must return strings/scalars for the LLM to consume).

Important: tools that mutate state (schedule, send, cancel) actually perform the
action — they are NOT just preview. The frontend rendering layer is responsible
for surfacing destructive actions to the user before they're invoked, e.g. via
quick-action chips on assistant messages. For now, `draft_reply` only DRAFTS
and does not auto-send; user must explicitly say "send it" to trigger the
send_message tool.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Optional

from langchain_core.tools import tool
from sqlalchemy.orm import Session

from . import models
from .db import SessionLocal
from .integrations.slack import SlackClient, SlackError
from .llm import summarize_messages
from .ws_manager import manager

log = logging.getLogger(__name__)


def _normalize_channel(name: str) -> str:
    return (name or "").lstrip("#@").strip()


def _find_channel(db: Session, name: str) -> Optional[models.SlackChannel]:
    if not name:
        return None
    norm = _normalize_channel(name)
    if not norm:
        return None
    # Try exact match first, then case-insensitive contains
    ch = db.query(models.SlackChannel).filter(models.SlackChannel.name == norm).first()
    if ch:
        return ch
    return (
        db.query(models.SlackChannel)
        .filter(models.SlackChannel.name.ilike(f"%{norm}%"))
        .first()
    )


# ---------- read tools ----------


@tool
def list_recent_activity(hours: int = 24) -> str:
    """Snapshot of channels with new messages in the last N hours (default 24). Use for 'what's new'."""
    db = SessionLocal()
    try:
        cutoff = datetime.utcnow() - timedelta(hours=hours)
        channels = db.query(models.SlackChannel).all()
        results = []
        for ch in channels:
            recent = (
                db.query(models.SlackMessage)
                .filter(
                    models.SlackMessage.channel_pk == ch.id,
                    models.SlackMessage.created_at >= cutoff,
                )
                .count()
            )
            if recent <= 0:
                continue
            last = (
                db.query(models.SlackMessage)
                .filter(models.SlackMessage.channel_pk == ch.id)
                .order_by(models.SlackMessage.ts.desc())
                .first()
            )
            results.append({
                "channel_pk": ch.id,
                "name": ch.name,
                "is_dm": bool(ch.is_im),
                "messages_recent": recent,
                "last_preview": (last.text[:140] if last else ""),
                "last_user": (last.user_name or last.user_id) if last else None,
            })
        results.sort(key=lambda r: r["messages_recent"], reverse=True)
        return json.dumps(results)
    finally:
        db.close()


@tool
def list_channels() -> str:
    """List all channels and DMs. ONLY for explicit 'list my channels' asks; otherwise use ask_user_to_pick_channel."""
    db = SessionLocal()
    try:
        chs = db.query(models.SlackChannel).order_by(models.SlackChannel.name).all()
        return json.dumps([
            {"channel_pk": c.id, "name": c.name, "is_dm": bool(c.is_im)}
            for c in chs
        ])
    finally:
        db.close()


@tool
def ask_user_to_pick_draft(action: str = "send") -> str:
    """Show an interactive draft picker when user wants to act on a draft but didn't name one. action: send|cancel|edit|refine|schedule."""
    action_norm = (action or "send").strip().lower()
    db = SessionLocal()
    try:
        if action_norm == "cancel":
            statuses = ["scheduled"]
        else:
            statuses = ["draft", "scheduled"]
        rows = (
            db.query(models.MessageDraft)
            .filter(models.MessageDraft.status.in_(statuses))
            .order_by(models.MessageDraft.created_at.desc())
            .limit(20)
            .all()
        )
        items = []
        for d in rows:
            ch = db.get(models.SlackChannel, d.channel_pk)
            items.append({
                "draft_id": d.id,
                "channel": ch.name if ch else "?",
                "is_dm": bool(ch.is_im) if ch else False,
                "body_preview": d.body[:160],
                "status": d.status,
                "scheduled_for": d.scheduled_for.isoformat() + "Z" if d.scheduled_for else None,
            })
        return json.dumps({
            "action": "pick_draft",
            "verb": action_norm,
            "drafts": items,
        })
    finally:
        db.close()


@tool
def ask_user_to_pick_channel(intent: str = "perform an action") -> str:
    """Show an interactive channel picker when user wants a channel-scoped action but didn't name a channel. intent is a short verb phrase (e.g. 'summarize')."""
    db = SessionLocal()
    try:
        chs = db.query(models.SlackChannel).order_by(models.SlackChannel.name).all()
        return json.dumps({
            "action": "pick_channel",
            "intent": intent.strip() or "perform an action",
            "channels": [
                {"channel_pk": c.id, "name": c.name, "is_dm": bool(c.is_im)}
                for c in chs
            ],
        })
    finally:
        db.close()


@tool
async def summarize_channel(channel: str, message_limit: int = 30) -> str:
    """Summarize recent messages in a channel. `channel` is the name without #/@."""
    db = SessionLocal()
    try:
        ch = _find_channel(db, channel)
        if not ch:
            return json.dumps({"error": f"No channel matches '{channel}'"})
        rows = (
            db.query(models.SlackMessage)
            .filter(models.SlackMessage.channel_pk == ch.id)
            .order_by(models.SlackMessage.ts.desc())
            .limit(message_limit)
            .all()
        )
        if not rows:
            return json.dumps({"channel": ch.name, "summary": "No messages.", "count": 0})
        # Truncate per-message text before sending to LLM.
        formatted = []
        for m in reversed(rows):
            text = (m.text or "").strip()
            if not text:
                continue
            if len(text) > MAX_MSG_CHARS:
                text = text[:MAX_MSG_CHARS] + "…"
            formatted.append({"user": m.user_name or m.user_id or "?", "text": text})
        summary = await summarize_messages(ch.name, formatted)
        return json.dumps({"channel": ch.name, "summary": summary, "count": len(rows)})
    finally:
        db.close()


# ---------- draft / write tools ----------


MAX_MSG_CHARS = 300  # truncate per-message text fed to the LLM


def _format_transcript(rows: list[models.SlackMessage]) -> str:
    """Build a token-efficient transcript: chronological, one line per message,
    each capped at MAX_MSG_CHARS, blank messages dropped."""
    lines: list[str] = []
    for m in reversed(rows):
        text = (m.text or "").replace("\n", " ").strip()
        if not text:
            continue
        if len(text) > MAX_MSG_CHARS:
            text = text[:MAX_MSG_CHARS] + "…"
        who = m.user_name or m.user_id or "?"
        lines.append(f"{who}: {text}")
    return "\n".join(lines)


@tool
async def draft_reply(channel: str, intent: str = "") -> str:
    """Draft (do NOT send) a reply for a channel. Optional intent verb-phrase like 'ack and ask for ETA'."""
    db = SessionLocal()
    try:
        ch = _find_channel(db, channel)
        if not ch:
            return json.dumps({"error": f"No channel matches '{channel}'"})
        rows = (
            db.query(models.SlackMessage)
            .filter(models.SlackMessage.channel_pk == ch.id)
            .order_by(models.SlackMessage.ts.desc())
            .limit(30)
            .all()
        )
        transcript = _format_transcript(rows)
        if not transcript:
            return json.dumps({"error": "Nothing to reply to."})

        # Lazy imports to avoid circular import at module load.
        from langchain_core.messages import HumanMessage, SystemMessage
        from .agents import DRAFT_PROMPT
        from .providers import draft_llm

        intent_block = f"\nUser intent: {intent.strip()}\n" if intent.strip() else ""
        user_content = (
            f"Channel: #{ch.name}\n\n"
            f"Recent messages (oldest first):\n{transcript}\n"
            f"{intent_block}\n"
            "Write a single reply message now. Output only the message body."
        )
        resp = await draft_llm().ainvoke([
            SystemMessage(content=DRAFT_PROMPT),
            HumanMessage(content=user_content),
        ])
        draft_text = (getattr(resp, "content", "") or "").strip()
        if not draft_text or draft_text == "NO_REPLY_NEEDED":
            return json.dumps({"error": "Nothing meaningful to reply to."})

        d = models.MessageDraft(
            channel_pk=ch.id,
            body=draft_text,
            status="draft",
        )
        db.add(d)
        db.commit()
        db.refresh(d)
        return json.dumps({
            "draft_id": d.id,
            "channel": ch.name,
            "channel_pk": ch.id,
            "body": d.body,
        })
    finally:
        db.close()


@tool
def update_draft(draft_id: int, new_body: str) -> str:
    """Replace a draft's body with user-provided text."""
    db = SessionLocal()
    try:
        d = db.get(models.MessageDraft, draft_id)
        if not d:
            return json.dumps({"error": f"Draft {draft_id} not found"})
        if d.status not in ("draft", "scheduled"):
            return json.dumps({"error": f"Cannot edit a {d.status} draft"})
        d.body = new_body
        db.commit()
        return json.dumps({"draft_id": d.id, "body": d.body, "status": d.status})
    finally:
        db.close()


# ---------- send / schedule tools ----------


async def _send_now(db: Session, d: models.MessageDraft) -> dict:
    ch = db.get(models.SlackChannel, d.channel_pk)
    acc = db.get(models.SlackAccount, ch.account_id) if ch else None
    if not (ch and acc):
        return {"error": "channel or account missing"}
    client = SlackClient(acc.access_token)
    try:
        result = await client.post_message(ch.channel_id, d.body)
        d.status = "sent"
        d.sent_at = datetime.utcnow()
        d.sent_ts = result.get("ts")
        d.scheduled_for = None
        db.commit()
        await manager.broadcast({
            "type": "draft.sent",
            "draft_id": d.id,
            "channel_pk": d.channel_pk,
            "sent_ts": d.sent_ts,
        })
        return {"draft_id": d.id, "status": "sent", "channel": ch.name, "ts": d.sent_ts}
    except SlackError as e:
        d.status = "failed"
        d.error = str(e)
        db.commit()
        return {"error": f"Slack: {e}"}
    finally:
        await client.aclose()


@tool
async def send_message(draft_id: int) -> str:
    """Send a draft to Slack now. ONLY call after explicit user confirmation ('send', 'go ahead'). Never after just drafting."""
    db = SessionLocal()
    try:
        d = db.get(models.MessageDraft, draft_id)
        if not d:
            return json.dumps({"error": f"Draft {draft_id} not found"})
        if d.status not in ("draft", "scheduled"):
            return json.dumps({"error": f"Draft is {d.status}; nothing to send"})
        result = await _send_now(db, d)
        return json.dumps(result)
    finally:
        db.close()


@tool
def schedule_message(draft_id: int, minutes_from_now: int) -> str:
    """Schedule a draft to send in N minutes. For absolute times use schedule_message_at."""
    if minutes_from_now <= 0:
        return json.dumps({"error": "minutes_from_now must be positive"})
    db = SessionLocal()
    try:
        d = db.get(models.MessageDraft, draft_id)
        if not d:
            return json.dumps({"error": f"Draft {draft_id} not found"})
        if d.status not in ("draft", "scheduled"):
            return json.dumps({"error": f"Cannot schedule a {d.status} draft"})
        when = datetime.utcnow() + timedelta(minutes=minutes_from_now)
        d.scheduled_for = when
        d.status = "scheduled"
        db.commit()
        return json.dumps({
            "draft_id": d.id,
            "status": "scheduled",
            "scheduled_for": when.isoformat() + "Z",
        })
    finally:
        db.close()


@tool
def schedule_message_at(draft_id: int, when_iso: str) -> str:
    """Schedule a draft for an absolute UTC datetime like '2026-05-19T09:00:00Z'."""
    try:
        when = datetime.fromisoformat(when_iso.rstrip("Z"))
    except ValueError:
        return json.dumps({"error": f"Bad ISO datetime: {when_iso}"})
    db = SessionLocal()
    try:
        d = db.get(models.MessageDraft, draft_id)
        if not d:
            return json.dumps({"error": f"Draft {draft_id} not found"})
        d.scheduled_for = when
        d.status = "scheduled"
        db.commit()
        return json.dumps({
            "draft_id": d.id,
            "status": "scheduled",
            "scheduled_for": when.isoformat() + "Z",
        })
    finally:
        db.close()


@tool
def list_drafts(status: str = "") -> str:
    """List drafts. Optional status filter: draft|scheduled|sent|cancelled|failed."""
    db = SessionLocal()
    try:
        q = db.query(models.MessageDraft).order_by(models.MessageDraft.created_at.desc())
        if status:
            q = q.filter(models.MessageDraft.status == status)
        rows = q.limit(30).all()
        out = []
        for d in rows:
            ch = db.get(models.SlackChannel, d.channel_pk)
            out.append({
                "draft_id": d.id,
                "channel": ch.name if ch else "?",
                "body_preview": d.body[:140],
                "status": d.status,
                "scheduled_for": d.scheduled_for.isoformat() + "Z" if d.scheduled_for else None,
            })
        return json.dumps(out)
    finally:
        db.close()


@tool
def cancel_draft(draft_id: int) -> str:
    """Cancel a draft or scheduled message before it sends."""
    db = SessionLocal()
    try:
        d = db.get(models.MessageDraft, draft_id)
        if not d:
            return json.dumps({"error": f"Draft {draft_id} not found"})
        if d.status == "sent":
            return json.dumps({"error": "Draft already sent, cannot cancel"})
        d.status = "cancelled"
        d.scheduled_for = None
        db.commit()
        return json.dumps({"draft_id": d.id, "status": "cancelled"})
    finally:
        db.close()


ALL_TOOLS = [
    list_recent_activity,
    list_channels,
    ask_user_to_pick_channel,
    ask_user_to_pick_draft,
    summarize_channel,
    draft_reply,
    update_draft,
    send_message,
    schedule_message,
    schedule_message_at,
    list_drafts,
    cancel_draft,
]
