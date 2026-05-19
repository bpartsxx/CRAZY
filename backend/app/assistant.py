"""Assistant agent — a LangGraph ReAct loop with messaging tools.

The agent is the main user-facing surface: free-form chat + tool use to act on
Slack data. Tools live in `tools.py`. Streaming is handled at the router level
via `astream_events`.
"""
from __future__ import annotations

from datetime import datetime

from langgraph.prebuilt import create_react_agent

from . import providers
from .tools import ALL_TOOLS

ASSISTANT_SYSTEM_PROMPT_TEMPLATE = """You are an AI communication assistant for a busy professional managing Slack messaging. Today is {today}.

Rules:
- NEVER call send_message unless the user's LAST message explicitly says "send" / "go ahead" / "yes send". After drafting, stop and ask.
- Channel-scoped action without a channel named → call ask_user_to_pick_channel and stop. Don't list channels in text.
- Draft action without a draft id → call ask_user_to_pick_draft and stop. Don't list drafts in text.
- "What's new" → call list_recent_activity, then bullet-summarize.
- After draft_reply runs, the UI shows the draft body in a card with action buttons. Your text reply must be ONE short line, max 10 words, e.g. "Drafted for #checktest — send, edit, or schedule?" NEVER repeat the draft body in your text. NEVER repeat the question.
- After send_message runs, the UI shows a "Sent" badge. Reply with ONE short confirmation, e.g. "Sent."
- After schedule_message runs, the UI shows a "Scheduled" badge. Reply with ONE short confirmation, e.g. "Scheduled for 9am."
- Use # for channels, @ for DMs. Be concise. No filler.
- Relative times → compute absolute, use schedule_message_at. Simple offsets → schedule_message."""


def _build_prompt() -> str:
    return ASSISTANT_SYSTEM_PROMPT_TEMPLATE.format(today=datetime.utcnow().strftime("%Y-%m-%d"))


_AGENTS: list | None = None


def get_agents() -> list:
    """Return compiled agents in fallback order. First is primary."""
    global _AGENTS
    if _AGENTS is None:
        chain = providers.agent_provider_chain()
        if not chain:
            raise RuntimeError("No LLM provider keys configured for the agent")
        _AGENTS = []
        for p in chain:
            try:
                _AGENTS.append(create_react_agent(
                    providers.agent_llm_for(p),
                    tools=ALL_TOOLS,
                    prompt=_build_prompt(),
                ))
            except Exception:
                # Skip providers that fail to build; keep going.
                pass
        if not _AGENTS:
            raise RuntimeError("Failed to build any agent")
    return _AGENTS
