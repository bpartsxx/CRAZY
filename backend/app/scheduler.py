"""Background worker that dispatches scheduled MessageDrafts when they come due.

Polls the DB every SCHED_INTERVAL seconds for status='scheduled' rows whose
scheduled_for has passed, then posts them via the Slack client. Updates the row
to status='sent' (or 'failed') and broadcasts a WS event so the UI can react.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from sqlalchemy.orm import Session

from . import models
from .db import SessionLocal
from .integrations.slack import SlackClient, SlackError
from .ws_manager import manager

log = logging.getLogger(__name__)

SCHED_INTERVAL = 10  # seconds


async def _dispatch(db: Session, draft: models.MessageDraft) -> None:
    ch = db.get(models.SlackChannel, draft.channel_pk)
    if not ch:
        draft.status = "failed"
        draft.error = "channel missing"
        db.commit()
        return
    acc = db.get(models.SlackAccount, ch.account_id)
    if not acc:
        draft.status = "failed"
        draft.error = "account missing"
        db.commit()
        return
    client = SlackClient(acc.access_token)
    try:
        result = await client.post_message(ch.channel_id, draft.body)
        draft.status = "sent"
        draft.sent_at = datetime.utcnow()
        draft.sent_ts = result.get("ts")
        draft.scheduled_for = None
        draft.error = None
        db.commit()
        await manager.broadcast({
            "type": "draft.sent",
            "draft_id": draft.id,
            "channel_pk": draft.channel_pk,
            "sent_ts": draft.sent_ts,
            "scheduled": True,
        })
        log.info("Dispatched scheduled draft %s to #%s", draft.id, ch.name)
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
        log.warning("Scheduled draft %s failed: %s", draft.id, e)
    finally:
        await client.aclose()


async def run_scheduler() -> None:
    log.info("Draft scheduler started (interval=%ss)", SCHED_INTERVAL)
    while True:
        try:
            db = SessionLocal()
            try:
                now = datetime.utcnow()
                due = (
                    db.query(models.MessageDraft)
                    .filter(
                        models.MessageDraft.status == "scheduled",
                        models.MessageDraft.scheduled_for.isnot(None),
                        models.MessageDraft.scheduled_for <= now,
                    )
                    .all()
                )
                for d in due:
                    try:
                        await _dispatch(db, d)
                    except Exception:
                        log.exception("Failed to dispatch draft %s", d.id)
            finally:
                db.close()
        except Exception:
            log.exception("Scheduler tick crashed")
        await asyncio.sleep(SCHED_INTERVAL)
