"""LLM wrapper for message summarization.

Uses Google Gemini via its OpenAI-compatible endpoint.
To swap providers, change BASE_URL, MODEL, and the API key env var.
"""
from __future__ import annotations

import logging

from openai import AsyncOpenAI

from .config import settings

log = logging.getLogger(__name__)

BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
MODEL = "gemini-2.5-flash"

SYSTEM_PROMPT = """You are an assistant that summarizes work-channel conversations \
for a busy professional. Given a transcript of recent messages from a single channel, \
produce a short, scannable summary. Format:

- Open with a one-sentence overall vibe (decisions, blockers, asks).
- Then 3-6 bullets covering: who said what mattered, open questions, action items.
- Skip greetings and small talk. Be concrete; quote short phrases when useful.
- If nothing important happened, say so in one line.

Use plain text, no markdown headers."""


_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        if not settings.google_api_key:
            raise RuntimeError("GOOGLE_API_KEY not set")
        _client = AsyncOpenAI(base_url=BASE_URL, api_key=settings.google_api_key)
    return _client


async def summarize_messages(channel_name: str, messages: list[dict]) -> str:
    """messages = [{"user": str, "text": str}, ...] in chronological order."""
    transcript_lines = [f"{m['user']}: {m['text']}" for m in messages if m.get("text")]
    if not transcript_lines:
        return "No textual messages to summarize."
    transcript = "\n".join(transcript_lines)

    user_content = (
        f"Channel: #{channel_name}\n"
        f"Recent messages (chronological):\n\n{transcript}\n\n"
        f"Summarize per the format in the system prompt."
    )

    client = _get_client()
    resp = await client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        temperature=0.5,
        max_tokens=1024,
    )
    return (resp.choices[0].message.content or "").strip()
