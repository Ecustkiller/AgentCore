"""LLM-call observability: the single emit point for ``llm.call`` and the
optional ``llm.request`` / ``llm.response`` body capture.

Why a shared helper: a finished LLM call has full metrics in exactly two places —
``DeepSeekProvider.complete`` (one-shot: memory / title) and
``engine._stream_llm_round`` (streaming: chat / worker). Both call
:func:`log_llm_call`, so every call — including any future caller — lands one
uniform ``llm.call`` line, attributed by ``scenario`` / ``model`` and (via
``contextvars``) by ``trace_id`` / ``conversation_id`` / worker identity. This is
the per-call layer the round/turn aggregates (``react.round_end`` /
``chat.turn_complete``) cannot give: per-model latency, finish_reason, and the
chat-vs-worker-vs-title-vs-memory split.

Bodies (the actual prompt + completion) are the lever for prompt tuning but are
large and sensitive, so they are OFF by default and only captured when
``settings.log_llm_bodies`` is on — always TRUNCATED and secret-redacted
(logging.mdc 铁律: never a BYOK key, never full file/message content). That single
switch fully controls them: when enabled they emit at ``info`` (not ``debug``), so
dev's default ``LOG_LEVEL=info`` surfaces them without also raising the global level
(which would flood the log with unrelated debug lines).
"""

from __future__ import annotations

import re

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.llm.protocol import LLMMessage, TokenUsage

logger = get_logger("agentcore.llm.call")

# Caps for the (debug-only) body capture: per-message, then the whole prompt /
# response blob. Bounds log volume and limits how much sensitive text can leak.
_MSG_MAX_CHARS = 600
_BODY_MAX_CHARS = 2000

# Defensive secret scrub for captured bodies. Bodies are chat/system prompts, not key
# stores, but a user could paste a key — never let it land in a log line. Covers the
# vendor key shapes this project + common providers use, beyond OpenAI-only ``sk-…``:
# OpenAI/DeepSeek/Anthropic/Moonshot/Stripe ``sk[-_]…``, Tavily ``tvly-…``, Groq
# ``gsk_…``, xAI ``xai-…``, Google ``AIza…``, GitHub ``gh?_…``, plus ``Bearer <token>``.
# Defence-in-depth on a default-off debug log — wide, not exhaustive (e.g. opaque
# prefix-less keys like Zhipu's can't be matched without over-redacting prose) (SEC-001).
_SECRET_RE = re.compile(
    r"(?:sk|tvly|gsk|xai)[-_][A-Za-z0-9._-]{8,}"
    r"|AIza[A-Za-z0-9._-]{16,}"
    r"|gh[opsru]_[A-Za-z0-9]{16,}"
    r"|[Bb]earer\s+[A-Za-z0-9._-]{8,}"
)


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + f"…(+{len(text) - limit})"


def _redact(text: str) -> str:
    return _SECRET_RE.sub("[REDACTED]", text)


def _format_prompt(messages: list[LLMMessage]) -> str:
    """Compact, per-message-clipped, redacted view of the request messages."""
    parts: list[str] = []
    for m in messages:
        body = m.content or ""
        if m.tool_calls:
            body += " " + " ".join(f"→{tc.function.name}()" for tc in m.tool_calls)
        if m.tool_call_id and not body:
            body = f"(tool result {m.tool_call_id})"
        parts.append(f"[{m.role}] {_clip(_redact(body), _MSG_MAX_CHARS)}")
    return _clip("\n".join(parts), _BODY_MAX_CHARS)


def log_llm_call(
    *,
    scenario: str,
    model: str,
    usage: TokenUsage | None,
    finish_reason: str | None,
    latency_ms: int,
    stream: bool,
    messages: list[LLMMessage] | None = None,
    content: str | None = None,
    reasoning: str | None = None,
) -> None:
    """Emit one ``llm.call`` metrics line (+ optional bodies when enabled).

    Inherits ``trace_id`` / ``conversation_id`` / ``agent_id`` / ``run_id`` /
    ``depth`` from contextvars, so calls attribute to their turn and worker.
    """
    u = usage or TokenUsage()
    logger.info(
        "llm.call",
        scenario=scenario,
        model=model,
        finish_reason=finish_reason or "stop",
        latency_ms=latency_ms,
        stream=stream,
        input_tokens=u.input_tokens,
        output_tokens=u.output_tokens,
        reasoning_tokens=u.reasoning_tokens,
        cache_hit_tokens=u.cache_hit_tokens,
        cache_miss_tokens=u.cache_miss_tokens,
    )

    if not settings.log_llm_bodies:
        return
    # Emitted at info (not debug) so the single ``log_llm_bodies`` switch is sufficient —
    # no need to also drop LOG_LEVEL to debug (which would flood unrelated debug lines).
    if messages is not None:
        logger.info("llm.request", scenario=scenario, model=model, prompt=_format_prompt(messages))
    if content is not None or reasoning is not None:
        logger.info(
            "llm.response",
            scenario=scenario,
            model=model,
            finish_reason=finish_reason or "stop",
            content=_clip(_redact(content or ""), _BODY_MAX_CHARS),
            reasoning=_clip(_redact(reasoning or ""), _BODY_MAX_CHARS),
        )
