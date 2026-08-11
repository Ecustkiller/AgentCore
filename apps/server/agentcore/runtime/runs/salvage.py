"""Freeze a mid-flight worker transcript for run_redirect 热续写.

Redirect cancel stops one in-flight worker. When the cancelled task already
carried serializable turns (≥1 assistant / tool message after the opening),
drive can build a partial :class:`RunSession` and ``continue_run``. An empty
(or only system/user opening) transcript fails the gate → cold ``_redir``
handoff instead.

整轮 stop still truncates without requiring hot continue; callers pass
``reason`` into ``run_cancelled`` separately.

Cancel terminal construction also mirrors COMPLETED/FAILED honesty: harvest
escalations already on the transcript and carry any spent token usage so a
``cancel_worker`` batch does not evaporate escalations / member billing.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import TYPE_CHECKING

from agentcore.llm.pricing import calculate_cost
from agentcore.llm.provider.protocol import TokenUsage, llm_content_text
from agentcore.runtime.runs.serialize import escalations_from_transcript
from agentcore.runtime.runs.session import RunSession
from agentcore.runtime.runs.types import RunPhase, RunState

if TYPE_CHECKING:
    from agentcore.llm.provider.protocol import LLMMessage
    from agentcore.runtime.runs.types import RunSpec


def is_continuable_transcript(messages: list[LLMMessage]) -> bool:
    """True when ``messages`` has ≥1 assistant or tool turn (partial 门槛).

    Opening system/user-only prompts are NOT enough — that is the「刚启动几乎空」
    cold path. Completed tool results and/or assistant drafts qualify.
    """
    return any(msg.role in ("assistant", "tool") for msg in messages)


def freeze_partial_transcript(messages: list[LLMMessage]) -> list[LLMMessage]:
    """Return a copy safe to resume from: drop a trailing unfinished tool call.

    Keep completed assistant+tool pairs and final assistant prose. If the last
    message is an assistant that opened tool_calls with no matching tool
    results yet, drop that incomplete assistant turn so the next ``continue_run``
    starts on a clean boundary (工具半途).
    """
    out = list(messages)
    if not out:
        return out
    last = out[-1]
    if last.role == "assistant" and last.tool_calls:
        # Incomplete tool fan-out — truncate the open call.
        out.pop()
    return out


def content_from_transcript(messages: list[LLMMessage]) -> str:
    """Best-effort draft body for display / session.content (last assistant text)."""
    for msg in reversed(messages):
        text = llm_content_text(msg.content)
        if msg.role == "assistant" and text.strip():
            return text
    return ""


def try_salvage_session(
    *,
    spec: RunSpec,
    messages: list[LLMMessage] | None,
) -> RunSession | None:
    """Build a partial RunSession when transcript clears the hot gate; else None."""
    if not messages:
        return None
    frozen = freeze_partial_transcript(messages)
    if not is_continuable_transcript(frozen):
        return None
    return RunSession(
        run_id=spec.run_id,
        spec=spec,
        transcript=frozen,
        content=content_from_transcript(frozen),
        partial=True,
    )


def cancelled_state_from_salvage(
    session: RunSession | None,
    *,
    error: str = "redirected",
    usage: TokenUsage | None = None,
    model: str | None = None,
    rounds: int = 0,
) -> RunState:
    """Terminal CANCELLED RunState with salvage transcript, escalations, and spend.

    Mirrors COMPLETED/FAILED honesty on the cancel path: escalate tool calls already
    on the transcript are harvested (same helper as the normal terminal builder), and
    any metered tokens are priced onto ``usage``/``cost`` so BatchMetrics / member
    ledger / turn_worker_stats see real spend instead of an empty CANCELLED shell.
    Empty usage when nothing was spent — same guard as ``_priced_failure``.
    """
    spent = usage or TokenUsage()
    has_usage = bool(spent.input_tokens or spent.output_tokens)
    usage_dict = spent.as_dict() if has_usage else {}
    cost_dict = asdict(calculate_cost(model, spent)) if (model and has_usage) else {}
    if session is None:
        return RunState(
            phase=RunPhase.CANCELLED,
            error=error,
            model=model or "",
            rounds=rounds,
            usage=usage_dict,
            cost=cost_dict,
        )
    transcript = list(session.transcript)
    return RunState(
        phase=RunPhase.CANCELLED,
        content=session.content,
        error=error,
        transcript=transcript,
        escalations=escalations_from_transcript(transcript),
        model=model or "",
        rounds=rounds,
        usage=usage_dict,
        cost=cost_dict,
    )
