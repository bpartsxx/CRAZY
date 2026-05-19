from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import models  # noqa: F401  (register models on Base before create_all)
from .config import settings
from .db import Base, SessionLocal, engine
from .poller import run_poller
from .routers import assistant as assistant_router
from .routers import drafts as drafts_router
from .routers import slack as slack_router
from .routers import ws as ws_router
from .scheduler import run_scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    if settings.slack_token:
        from .integrations.slack import SlackClient
        client = SlackClient(settings.slack_token)
        try:
            info = await client.auth_test()
            db = SessionLocal()
            try:
                team_id = info.get("team_id") or "unknown"
                existing = db.query(models.SlackAccount).filter_by(team_id=team_id).first()
                if existing:
                    existing.access_token = settings.slack_token
                else:
                    db.add(models.SlackAccount(
                        team_id=team_id,
                        team_name=info.get("team", "Workspace"),
                        access_token=settings.slack_token,
                        token_type="user" if settings.slack_token.startswith("xoxp-") else "bot",
                        authed_user_id=info.get("user_id"),
                    ))
                    db.commit()
                log.info("Slack ready (team=%s, user=%s)", info.get("team"), info.get("user"))
            finally:
                db.close()
        except Exception:
            log.exception("Failed to verify SLACK_TOKEN")
        finally:
            await client.aclose()

    poller_task = asyncio.create_task(run_poller())
    scheduler_task = asyncio.create_task(run_scheduler())
    try:
        yield
    finally:
        for t in (poller_task, scheduler_task):
            t.cancel()
        for t in (poller_task, scheduler_task):
            try:
                await t
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Unified Inbox", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # Allow localhost + any RFC1918 private LAN address. Personal app, trusted
    # network. Tighten this in production.
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1|\[::1\]|10\.[0-9.]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9.]+|192\.168\.[0-9.]+)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(slack_router.router)
app.include_router(drafts_router.router)
app.include_router(assistant_router.router)
app.include_router(ws_router.router)


@app.get("/health")
def health():
    from .providers import active_provider_summary
    return {"ok": True, "providers": active_provider_summary()}
