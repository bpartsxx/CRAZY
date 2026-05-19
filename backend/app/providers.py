"""Multi-provider LLM routing with auto-fallback.

Each task has an ordered chain of providers. The first one with a configured
API key is used as primary; the rest become fallbacks. For .ainvoke-style
calls (drafter / summary) we use LangChain's `.with_fallbacks()` which
transparently retries on errors. For the ReAct agent (which binds tools at
compile time) we build one CompiledStateGraph per provider and the router
walks the list on 429 — see assistant.get_agents() and routers/assistant.py.

Default chains keep Groq LAST because its free-tier TPD is the lowest of the
three providers.
"""
from __future__ import annotations

from typing import Literal

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.runnables import Runnable
from langchain_groq import ChatGroq
from langchain_openai import ChatOpenAI

from .config import settings

CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"
SAMBANOVA_BASE_URL = "https://api.sambanova.ai/v1"

Provider = Literal["cerebras", "sambanova", "groq"]
Size = Literal["70b", "8b"]


def _has_key(p: Provider) -> bool:
    if p == "cerebras": return bool(settings.cerebras_api_key)
    if p == "sambanova": return bool(settings.sambanova_api_key)
    if p == "groq": return bool(settings.groq_api_key)
    return False


def _model_id(p: Provider, size: Size) -> str:
    if p == "cerebras":
        return settings.cerebras_70b_model if size == "70b" else settings.cerebras_8b_model
    if p == "sambanova":
        return settings.sambanova_70b_model if size == "70b" else settings.sambanova_8b_model
    return settings.groq_70b_model if size == "70b" else settings.groq_8b_model


def build_llm(p: Provider, size: Size, temperature: float, max_tokens: int = 600) -> BaseChatModel:
    if not _has_key(p):
        raise RuntimeError(f"{p.upper()}_API_KEY not set")
    model = _model_id(p, size)
    if p == "groq":
        return ChatGroq(model=model, api_key=settings.groq_api_key, temperature=temperature, max_tokens=max_tokens)
    if p == "cerebras":
        return ChatOpenAI(
            model=model, api_key=settings.cerebras_api_key, base_url=CEREBRAS_BASE_URL,
            temperature=temperature, max_tokens=max_tokens,
        )
    if p == "sambanova":
        return ChatOpenAI(
            model=model, api_key=settings.sambanova_api_key, base_url=SAMBANOVA_BASE_URL,
            temperature=temperature, max_tokens=max_tokens,
        )
    raise ValueError(p)


def _available(chain: list[Provider]) -> list[Provider]:
    """Filter a chain to providers with configured keys, preserving order."""
    return [p for p in chain if _has_key(p)]


def _chain(chain: list[Provider], size: Size, temperature: float, max_tokens: int = 600) -> Runnable:
    """Build primary with .with_fallbacks() if more than one provider is available."""
    avail = _available(chain)
    if not avail:
        raise RuntimeError(f"No provider key set for any of: {chain}")
    primary = build_llm(avail[0], size, temperature, max_tokens)
    if len(avail) == 1:
        return primary
    fallbacks = [build_llm(p, size, temperature, max_tokens) for p in avail[1:]]
    return primary.with_fallbacks(fallbacks)


# ---------- task chains ----------
# Groq is intentionally LAST in every chain — its 100k/day TPD is the bottleneck.

AGENT_CHAIN:   list[Provider] = ["cerebras", "sambanova", "groq"]
DRAFT_CHAIN:   list[Provider] = ["cerebras", "sambanova", "groq"]
SUMMARY_CHAIN: list[Provider] = ["sambanova", "cerebras", "groq"]


def draft_llm() -> Runnable:
    """Creative writing for reply drafts. Auto-falls-over on 429."""
    return _chain(DRAFT_CHAIN, "70b", temperature=0.85, max_tokens=600)


def summary_llm() -> Runnable:
    """Factual summarization. Auto-falls-over on 429."""
    return _chain(SUMMARY_CHAIN, "8b", temperature=0.4, max_tokens=600)


def agent_provider_chain() -> list[Provider]:
    """Providers to try for the agent, in order. Used by assistant.get_agents()."""
    return _available(AGENT_CHAIN)


def agent_llm_for(p: Provider) -> BaseChatModel:
    """Build a single-provider LLM for the agent (tool-calling)."""
    return build_llm(p, "70b", temperature=0.3, max_tokens=600)


def active_provider_summary() -> dict:
    """Diagnostic shown on /health — chain order per task."""
    def fmt(chain: list[Provider]) -> str:
        avail = _available(chain)
        return " > ".join(avail) if avail else "(no provider keys)"
    return {
        "agent":   fmt(AGENT_CHAIN),
        "drafter": fmt(DRAFT_CHAIN),
        "summary": fmt(SUMMARY_CHAIN),
    }
