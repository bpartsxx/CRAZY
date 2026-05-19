"""LLM wrapper for message summarization (Inbox view's Brief button).

Routes to SambaNova when its key is present (separate quota bucket from the
agent's Groq calls). Falls back to Groq if no SambaNova key is configured.
"""
from __future__ import annotations

import logging
from typing import AsyncIterator

from openai import AsyncOpenAI

from .config import settings

log = logging.getLogger(__name__)

SAMBANOVA_BASE = "https://api.sambanova.ai/v1"
GROQ_BASE = "https://api.groq.com/openai/v1"

SYSTEM_PROMPT = """You are an assistant that summarizes work-channel conversations \
for a busy professional. Given a transcript of recent messages from a single channel, \
produce a short, scannable summary. Format:

- Open with a one-sentence overall vibe (decisions, blockers, asks).
- Then 3-6 bullets covering: who said what mattered, open questions, action items.
- Skip greetings and small talk. Be concrete; quote short phrases when useful.
- If nothing important happened, say so in one line.

Use plain text, no markdown headers."""


_client: AsyncOpenAI | None = None
_client_model: str = ""


def _get_client() -> tuple[AsyncOpenAI, str]:
    """Return (client, model). Prefers SambaNova so we don't compete with the
    Groq agent loop for quota; falls back to Groq if SambaNova isn't configured.
    """
    global _client, _client_model
    if _client is None:
        if settings.sambanova_api_key:
            _client = AsyncOpenAI(base_url=SAMBANOVA_BASE, api_key=settings.sambanova_api_key)
            _client_model = settings.sambanova_summary_model
        elif settings.groq_api_key:
            _client = AsyncOpenAI(base_url=GROQ_BASE, api_key=settings.groq_api_key)
            _client_model = settings.summary_model
        else:
            raise RuntimeError("Neither SAMBANOVA_API_KEY nor GROQ_API_KEY is set")
    return _client, _client_model


def _build_user_content(channel_name: str, messages: list[dict]) -> str | None:
    transcript_lines = [f"{m['user']}: {m['text']}" for m in messages if m.get("text")]
    if not transcript_lines:
        return None
    transcript = "\n".join(transcript_lines)
    return (
        f"Channel: #{channel_name}\n"
        f"Recent messages (chronological):\n\n{transcript}\n\n"
        f"Summarize per the format in the system prompt."
    )


async def summarize_messages(channel_name: str, messages: list[dict]) -> str:
    """messages = [{"user": str, "text": str}, ...] in chronological order."""
    user_content = _build_user_content(channel_name, messages)
    if user_content is None:
        return "No textual messages to summarize."

    client, model = _get_client()
    resp = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        temperature=0.5,
        max_tokens=600,
    )
    return (resp.choices[0].message.content or "").strip()


async def stream_summary(channel_name: str, messages: list[dict]) -> AsyncIterator[str]:
    """Yield summary text incrementally as the model produces it."""
    user_content = _build_user_content(channel_name, messages)
    if user_content is None:
        yield "No textual messages to summarize."
        return

    client, model = _get_client()
    stream = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        temperature=0.5,
        max_tokens=600,
        stream=True,
    )
    async for event in stream:
        if not event.choices:
            continue
        delta = event.choices[0].delta
        chunk = getattr(delta, "content", None)
        if chunk:
            yield chunk
