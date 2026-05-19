"""Assistant routes: streaming chat + activity snapshot for the UI rail."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import AsyncIterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from sqlalchemy.orm import Session

from .. import models, providers, schemas
from ..assistant import get_agents
from ..db import get_db

log = logging.getLogger(__name__)

router = APIRouter(prefix="/assistant", tags=["assistant"])

# How many prior messages of conversation history to send to the LLM. The full
# transcript is still kept client-side (localStorage); we just don't replay it
# all on every turn — token cost grows unbounded otherwise. 20 = ~10 turns
# of back-and-forth, enough for the assistant to keep context across a
# multi-step task while staying well under per-call token budgets.
MAX_HISTORY_MESSAGES = 20


def _to_lc_messages(history: list[schemas.ChatHistoryItem]) -> list[BaseMessage]:
    """Convert the frontend-friendly chat history into LangChain BaseMessages."""
    out: list[BaseMessage] = []
    for item in history:
        if item.role == "user":
            out.append(HumanMessage(content=item.content))
        elif item.role == "assistant":
            # Include any tool calls so the agent can pair tool results properly
            kwargs: dict = {}
            if item.tool_calls:
                kwargs["tool_calls"] = item.tool_calls
            out.append(AIMessage(content=item.content or "", **kwargs))
        elif item.role == "tool":
            out.append(ToolMessage(
                content=item.content,
                tool_call_id=item.tool_call_id or "",
                name=item.name or "",
            ))
        elif item.role == "system":
            out.append(SystemMessage(content=item.content))
    return out


@router.post("/chat")
async def chat(payload: schemas.ChatIn):
    """Stream the assistant's response as SSE.

    Events:
      - token         {text}                  assistant text chunk
      - tool_start    {name, input, id}       tool about to run
      - tool_end      {name, output, id}      tool finished, output JSON-encoded
      - artifact      {type, ...}             structured payload for UI (draft, etc.)
      - error         {error}
      - done          {messages: [...]}       full updated history (frontend persists)
    """
    def _should_failover(e: Exception) -> bool:
        """Whether an agent failure should hop to the next provider in the chain.
        Covers rate limits AND provider misconfigurations (bad model id, no access)
        so a wrong default doesn't take the whole agent down."""
        s = str(e).lower()
        return any(t in s for t in (
            "429", "rate limit", "rate_limit", "tpd", "too many requests",
            "model_not_found", "does not exist", "no access",
            "404", "401", "403", "invalid_api_key",
        ))

    async def _stream_one(agent, history) -> "AsyncIterator[tuple[str, str | None]]":
        """Yield (sse_frame, commit_marker) tuples. commit_marker is non-None
        once we've emitted anything the user has seen — past that point we
        can't safely retry with another provider."""
        committed: str | None = None
        async for event in agent.astream_events(
            {"messages": history},
            {"recursion_limit": 50},
            version="v2",
        ):
            kind = event.get("event")
            name = event.get("name", "")
            data = event.get("data", {}) or {}

            if kind == "on_chat_model_stream":
                chunk = data.get("chunk")
                text = getattr(chunk, "content", "") if chunk else ""
                if text:
                    committed = committed or "token"
                    yield f"event: token\ndata: {json.dumps({'text': text})}\n\n", committed
            elif kind == "on_tool_start":
                tool_input = data.get("input")
                committed = committed or "tool"
                yield (
                    "event: tool_start\n"
                    f"data: {json.dumps({'name': name, 'input': tool_input, 'id': event.get('run_id', '')})}\n\n",
                    committed,
                )
            elif kind == "on_tool_end":
                raw = data.get("output")
                output_str = raw.content if hasattr(raw, "content") else str(raw)
                committed = committed or "tool"
                yield (
                    f"event: tool_end\ndata: {json.dumps({'name': name, 'output': output_str[:2000], 'id': event.get('run_id', '')})}\n\n",
                    committed,
                )
                # Surface structured artifacts the UI can render.
                artifact_payload = None
                try:
                    parsed = json.loads(output_str)
                    if name in {"draft_reply", "update_draft"} and "draft_id" in parsed and "body" in parsed:
                        artifact_payload = {"type": "draft", **parsed}
                    elif name == "send_message" and parsed.get("status") == "sent":
                        artifact_payload = {"type": "sent", **parsed}
                    elif name in {"schedule_message", "schedule_message_at"} and parsed.get("status") == "scheduled":
                        artifact_payload = {"type": "scheduled", **parsed}
                    elif name == "ask_user_to_pick_channel" and parsed.get("action") == "pick_channel":
                        artifact_payload = {"type": "channel_picker", **parsed}
                    elif name == "ask_user_to_pick_draft" and parsed.get("action") == "pick_draft":
                        artifact_payload = {"type": "draft_picker", **parsed}
                except Exception:
                    pass
                if artifact_payload is not None:
                    yield f"event: artifact\ndata: {json.dumps(artifact_payload)}\n\n", committed

    async def gen():
        try:
            agents = get_agents()
            provider_chain = providers.agent_provider_chain()
            trimmed = payload.history[-MAX_HISTORY_MESSAGES:]
            history = _to_lc_messages(trimmed)
            history.append(HumanMessage(content=payload.message))
        except Exception as e:  # noqa: BLE001
            log.exception("assistant chat setup failed")
            yield f"event: error\ndata: {json.dumps({'error': f'setup: {e}'})}\n\n"
            return

        last_err: Exception | None = None
        for i, agent in enumerate(agents):
            committed: str | None = None
            try:
                async for frame, mark in _stream_one(agent, history):
                    committed = mark
                    yield frame
                yield "event: done\ndata: {}\n\n"
                return
            except Exception as e:  # noqa: BLE001
                last_err = e
                failover = _should_failover(e)
                has_next = i + 1 < len(agents)
                if failover and has_next and committed is None:
                    next_p = provider_chain[i + 1] if i + 1 < len(provider_chain) else "next provider"
                    log.warning("agent on %s failed (%s), failing over to %s",
                                provider_chain[i], type(e).__name__, next_p)
                    yield (
                        "event: info\n"
                        f"data: {json.dumps({'message': f'{provider_chain[i]} failed — switching to {next_p}'})}\n\n"
                    )
                    continue
                log.exception("assistant chat failed (committed=%s)", committed)
                yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
                return

        yield f"event: error\ndata: {json.dumps({'error': f'All providers exhausted: {last_err}'})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/activity", response_model=schemas.ActivityOut)
def activity(db: Session = Depends(get_db)):
    """Snapshot for the right-rail: channels with recent traffic + open drafts.

    This is the on-demand activity feed; the user (or the assistant) can query
    it whenever. No proactive notifications.
    """
    cutoff = datetime.utcnow() - timedelta(hours=24)
    channels = db.query(models.SlackChannel).all()
    out_channels = []
    for ch in channels:
        recent_count = (
            db.query(models.SlackMessage)
            .filter(
                models.SlackMessage.channel_pk == ch.id,
                models.SlackMessage.created_at >= cutoff,
            )
            .count()
        )
        if recent_count <= 0:
            continue
        last = (
            db.query(models.SlackMessage)
            .filter(models.SlackMessage.channel_pk == ch.id)
            .order_by(models.SlackMessage.ts.desc())
            .first()
        )
        out_channels.append(schemas.ActivityChannel(
            channel_pk=ch.id,
            name=ch.name,
            is_dm=bool(ch.is_im),
            unread=recent_count,
            last_preview=(last.text[:160] if last else ""),
            last_user=(last.user_name or last.user_id) if last else None,
            last_ts=last.ts if last else None,
        ))
    out_channels.sort(key=lambda c: c.unread, reverse=True)

    open_drafts = (
        db.query(models.MessageDraft)
        .filter(models.MessageDraft.status.in_(["draft", "scheduled"]))
        .order_by(models.MessageDraft.created_at.desc())
        .limit(20)
        .all()
    )
    out_drafts = []
    for d in open_drafts:
        ch = db.get(models.SlackChannel, d.channel_pk)
        out_drafts.append(schemas.ActivityDraft(
            draft_id=d.id,
            channel=ch.name if ch else "?",
            body_preview=d.body[:160],
            status=d.status,
            scheduled_for=d.scheduled_for,
        ))

    return schemas.ActivityOut(channels=out_channels, drafts=out_drafts)
