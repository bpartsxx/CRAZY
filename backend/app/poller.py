"""Background poller that fetches new Slack messages and broadcasts them via WS.

Slack's free Events API webhook flow needs a public URL (ngrok in dev), so for
v1 we just poll. Switch to Events API later by replacing this with a webhook
endpoint that calls the same `_persist_messages` helper.
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy.orm import Session

from . import models
from .config import settings
from .db import SessionLocal
from .integrations.slack import SlackClient, SlackError
from .ws_manager import manager

log = logging.getLogger(__name__)

_USER_CACHE: dict[tuple[int, str], str] = {}


async def _resolve_username(client: SlackClient, account_id: int, user_id: str | None) -> str | None:
    if not user_id:
        return None
    key = (account_id, user_id)
    if key in _USER_CACHE:
        return _USER_CACHE[key]
    user = await client.get_user(user_id)
    name = (user or {}).get("real_name") or (user or {}).get("name") if user else None
    if name:
        _USER_CACHE[key] = name
    return name


async def _sync_channels(client: SlackClient, db: Session, account: models.SlackAccount) -> None:
    remote = await client.list_channels()
    existing = {c.channel_id: c for c in account.channels}
    for ch in remote:
        # Skip channels the bot/user isn't a member of — fetching history will fail anyway.
        if not ch.get("is_member") and not ch.get("is_im"):
            continue
        cid = ch["id"]
        name = ch.get("name") or ch.get("user") or cid
        if cid in existing:
            existing[cid].name = name
        else:
            db.add(models.SlackChannel(
                account_id=account.id,
                channel_id=cid,
                name=name,
                is_private=bool(ch.get("is_private")),
                is_im=bool(ch.get("is_im")),
            ))
    db.commit()


async def _poll_account(db: Session, account: models.SlackAccount) -> int:
    client = SlackClient(account.access_token)
    new_count = 0
    try:
        await _sync_channels(client, db, account)
        # Refresh after sync
        channels = db.query(models.SlackChannel).filter_by(account_id=account.id).all()
        for ch in channels:
            try:
                msgs = await client.fetch_history(ch.channel_id, oldest=ch.last_polled_ts, limit=50)
            except SlackError as e:
                log.warning("fetch_history failed for %s: %s", ch.name, e)
                continue
            if not msgs:
                continue
            # Slack returns newest-first; iterate oldest-first so last_polled_ts moves forward.
            for m in reversed(msgs):
                ts = m.get("ts")
                if not ts or m.get("subtype") in {"channel_join", "channel_leave"}:
                    continue
                exists = (
                    db.query(models.SlackMessage)
                    .filter_by(channel_pk=ch.id, ts=ts)
                    .first()
                )
                if exists:
                    continue
                user_name = await _resolve_username(client, account.id, m.get("user"))
                row = models.SlackMessage(
                    channel_pk=ch.id,
                    ts=ts,
                    user_id=m.get("user"),
                    user_name=user_name,
                    text=m.get("text", ""),
                )
                db.add(row)
                db.flush()
                new_count += 1
                await manager.broadcast({
                    "type": "slack.message",
                    "account_id": account.id,
                    "channel_pk": ch.id,
                    "channel_name": ch.name,
                    "message": {
                        "id": row.id,
                        "ts": row.ts,
                        "user_name": row.user_name,
                        "text": row.text,
                    },
                })
                ch.last_polled_ts = ts
            db.commit()
    finally:
        await client.aclose()
    return new_count


async def poll_once(db: Session) -> dict:
    accounts = db.query(models.SlackAccount).all()
    total = 0
    for acc in accounts:
        try:
            total += await _poll_account(db, acc)
        except Exception:
            log.exception("Polling account %s failed", acc.team_name)
    return {"accounts": len(accounts), "new_messages": total}


async def run_poller() -> None:
    log.info("Slack poller started (interval=%ss)", settings.slack_poll_interval_seconds)
    while True:
        db = SessionLocal()
        try:
            await poll_once(db)
        except Exception:
            log.exception("poll_once crashed")
        finally:
            db.close()
        await asyncio.sleep(settings.slack_poll_interval_seconds)
