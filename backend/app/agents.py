"""LangGraph 2-stage pipeline: channel transcript -> summary -> drafted reply.

Two Gemini models with different temperatures play distinct roles:
  - summarize_node : gemini-2.5-flash @ T=0.4   (fast, factual)
  - draft_node     : gemini-2.5-pro   @ T=0.7   (better creative writing)

We expose:
  - stream_draft_pipeline(...): async generator that yields token chunks for
    each phase, suitable for SSE.
  - refine_draft(...): one-shot refine call for an existing draft + instruction.

Extending the graph (add a "tone_check" node, a "shorten" branch, etc.) is
just `.add_node` + `.add_edge`. The structure is in place.
"""
from __future__ import annotations

from typing import AsyncIterator, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, StateGraph

from .config import settings

SUMMARY_PROMPT = """You are an assistant that summarizes work-channel conversations \
for a busy professional. Given a transcript of recent messages from a single channel, \
produce a short, scannable summary. Format:

- Open with a one-sentence overall vibe (decisions, blockers, asks).
- Then 3-6 bullets covering: who said what mattered, open questions, action items.
- Skip greetings and small talk. Be concrete; quote short phrases when useful.
- If nothing important happened, say so in one line.

Use plain text, no markdown headers."""

DRAFT_PROMPT = """You are an assistant that drafts thoughtful reply messages on behalf \
of the user, for posting back into the same chat channel.

Guidelines:
- One message only. Plain text. Slack-friendly (short paragraphs, no markdown headers).
- Match the tone of the channel (formal vs casual). Default to warm and direct.
- Be specific: reference concrete points from the summary. Don't restate the whole summary.
- If the user gave an intent ("ack and ask for ETA", "decline politely"), follow it.
- If there is genuinely nothing to reply to, output: NO_REPLY_NEEDED
- No greetings like "Hi team," unless it fits the channel norm.
- Output ONLY the message body. No prefixes, no quotes, no explanations."""


class DraftState(TypedDict, total=False):
    channel_name: str
    messages: list[dict]   # [{"user": str, "text": str}, ...]
    summary: str
    intent: str
    draft: str


def _require_key() -> None:
    if not settings.google_api_key:
        raise RuntimeError("GOOGLE_API_KEY not set")


def _summary_llm() -> ChatGoogleGenerativeAI:
    _require_key()
    return ChatGoogleGenerativeAI(
        model=settings.summary_model,
        google_api_key=settings.google_api_key,
        temperature=0.4,
    )


def _draft_llm() -> ChatGoogleGenerativeAI:
    # Higher temperature gives the drafter a distinct, more creative voice
    # even when sharing the same underlying model as the summarizer.
    _require_key()
    return ChatGoogleGenerativeAI(
        model=settings.draft_model,
        google_api_key=settings.google_api_key,
        temperature=0.85,
    )


async def summarize_node(state: DraftState) -> dict:
    transcript = "\n".join(
        f"{m['user']}: {m['text']}" for m in state.get("messages", []) if m.get("text")
    )
    if not transcript.strip():
        return {"summary": "No textual messages to summarize."}
    resp = await _summary_llm().ainvoke([
        SystemMessage(content=SUMMARY_PROMPT),
        HumanMessage(content=f"Channel: #{state['channel_name']}\n\nMessages:\n{transcript}"),
    ])
    return {"summary": (resp.content or "").strip()}


async def draft_node(state: DraftState) -> dict:
    summary = state.get("summary") or ""
    if not summary or summary.startswith("No textual"):
        return {"draft": ""}
    intent = (state.get("intent") or "").strip()
    parts = [
        f"Channel: #{state['channel_name']}",
        "",
        "Summary of recent activity:",
        summary,
    ]
    if intent:
        parts += ["", "User's intent for this reply:", intent]
    parts += ["", "Write a single reply message now."]
    resp = await _draft_llm().ainvoke([
        SystemMessage(content=DRAFT_PROMPT),
        HumanMessage(content="\n".join(parts)),
    ])
    return {"draft": (resp.content or "").strip()}


def _build_graph():
    g = StateGraph(DraftState)
    g.add_node("summarize", summarize_node)
    g.add_node("write_draft", draft_node)
    g.set_entry_point("summarize")
    g.add_edge("summarize", "write_draft")
    g.add_edge("write_draft", END)
    return g.compile()


_GRAPH = None


def get_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = _build_graph()
    return _GRAPH


async def stream_draft_pipeline(
    channel_name: str,
    messages: list[dict],
    intent: str = "",
) -> AsyncIterator[tuple[str, str | dict]]:
    """Yield (event_kind, payload) tuples.

    Event kinds:
      - "phase"          payload = "summary" | "draft"
      - "summary_chunk"  payload = str (token text)
      - "draft_chunk"    payload = str (token text)
      - "done"           payload = {"summary": str, "draft": str}
    """
    graph = get_graph()
    initial: DraftState = {
        "channel_name": channel_name,
        "messages": messages,
        "intent": intent,
    }
    summary_buf: list[str] = []
    draft_buf: list[str] = []
    summary_started = False
    draft_started = False

    async for event in graph.astream_events(initial, version="v2"):
        kind = event.get("event")
        node = (event.get("metadata") or {}).get("langgraph_node")
        if kind == "on_chat_model_stream":
            chunk_obj = event.get("data", {}).get("chunk")
            chunk = getattr(chunk_obj, "content", "") if chunk_obj else ""
            if not chunk:
                continue
            if node == "summarize":
                if not summary_started:
                    summary_started = True
                    yield ("phase", "summary")
                summary_buf.append(chunk)
                yield ("summary_chunk", chunk)
            elif node == "write_draft":
                if not draft_started:
                    draft_started = True
                    yield ("phase", "draft")
                draft_buf.append(chunk)
                yield ("draft_chunk", chunk)

    yield ("done", {"summary": "".join(summary_buf).strip(), "draft": "".join(draft_buf).strip()})


async def refine_draft(channel_name: str, summary: str, current_draft: str, instruction: str) -> str:
    """Re-draft a single message given a user instruction (e.g. 'shorter, friendlier')."""
    prompt = (
        f"Channel: #{channel_name}\n\n"
        f"Context summary:\n{summary or '(none)'}\n\n"
        f"Existing draft:\n{current_draft}\n\n"
        f"User wants this change:\n{instruction}\n\n"
        f"Rewrite the message accordingly. Output only the new message body."
    )
    resp = await _draft_llm().ainvoke([
        SystemMessage(content=DRAFT_PROMPT),
        HumanMessage(content=prompt),
    ])
    return (resp.content or "").strip()
