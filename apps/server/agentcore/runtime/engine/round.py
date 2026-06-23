"""Single ReAct round: request projection, LLM streaming, facts, no-tool finish paths."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from agentcore.config import settings
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import error_fields_for
from agentcore.core.logging import get_logger
from agentcore.llm.config import ModelProfile, build_request
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.protocol import LLMMessage, TokenUsage
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    content_reset,
    error_event,
)
from agentcore.runtime.facts import LlmCallFact, NoteFact, RoundBoundaryFact, record_turn_fact
from agentcore.runtime.loop_controller import Intervention, LoopController
from agentcore.runtime.verify import finish_guard, format_guard_steer

from .segments import join_segments, tool_calls_to_dicts
from .stream import stream_llm_round
from .tool_clear import project_cleared_window

logger = get_logger(__name__)


def record_round_start(*, round_idx: int, run_id: str, role: str) -> None:
    """Mark a ReAct round boundary for journal fold (§18.3)."""
    record_turn_fact(RoundBoundaryFact(round_idx=round_idx, run_id=run_id, role=role).to_fact())


def build_request_window(
    messages: list[LLMMessage],
    investigation_tools: frozenset[str],
    round_idx: int,
) -> list[LLMMessage]:
    """Project the LLM window with optional tool-result clearing."""
    if not investigation_tools:
        return messages
    cleared = project_cleared_window(
        messages,
        clearable_tools=investigation_tools,
        keep_recent=settings.engine_tool_clear_keep_recent,
        min_chars=settings.engine_tool_clear_min_chars,
    )
    if cleared is messages:
        return messages
    chars_saved = sum(
        len(old.content or "") - len(new.content or "")
        for old, new in zip(messages, cleared, strict=True)
        if old.content != new.content
    )
    n_cleared = sum(
        1
        for old, new in zip(messages, cleared, strict=True)
        if old.content != new.content
    )
    logger.info(
        "engine.tool_clear",
        cleared=n_cleared,
        chars_saved=chars_saved,
        round=round_idx,
    )
    return cleared


@dataclass(frozen=True)
class LlmRoundOutput:
    """Successful LLM round: streamed content, reasoning, and optional tool calls."""

    content: str
    reasoning: str
    tool_calls: list[Any]
    usage: TokenUsage | None


@dataclass(frozen=True)
class LlmRoundFailure:
    """LLM call failed; caller should return accumulated state."""

    rounds: int


async def run_llm_round(
    *,
    llm: DeepSeekProvider,
    profile: ModelProfile,
    messages: list[LLMMessage],
    investigation_tools: frozenset[str],
    tool_defs: list[dict[str, Any]] | None,
    active_model: str | None,
    emit_content: Callable[[str], None],
    emit_reasoning: Callable[[str], None],
    on_tool_progress: Callable[[str, int], None] | None,
    round_idx: int,
    run_id: str,
    raise_on_error: bool,
    sink: EventSink,
) -> LlmRoundOutput | LlmRoundFailure:
    """Stream one LLM round; record facts and round_end log on success."""
    request_window = build_request_window(messages, investigation_tools, round_idx)
    request = build_request(
        profile,
        request_window,
        tools=tool_defs,
        tool_choice="auto" if tool_defs else "none",
        model=active_model,
    )
    try:
        round_content, round_reasoning, round_tool_calls, usage = await stream_llm_round(
            llm, request, emit_content, emit_reasoning, on_tool_progress
        )
    except Exception as e:
        logger.error("llm.call_failed", round=round_idx, error=str(e))
        if raise_on_error:
            raise
        code, message = error_fields_for(
            e,
            fallback_code=ErrorCode.LLM_ERROR,
            fallback_message="出了点问题，请稍后重试。",
        )
        sink.emit(error_event(code, message))
        return LlmRoundFailure(rounds=round_idx + 1)

    record_turn_fact(
        LlmCallFact(
            run_id=run_id,
            round_idx=round_idx,
            content=round_content,
            reasoning_content=round_reasoning,
            tool_calls=tool_calls_to_dicts(round_tool_calls),
            usage=usage.as_dict() if usage else {},
            finish_reason="tool_calls" if round_tool_calls else "stop",
        ).to_fact()
    )

    logger.info(
        "react.round_end",
        round=round_idx,
        tools=len(round_tool_calls) if round_tool_calls else 0,
        input_tokens=usage.input_tokens if usage else 0,
        output_tokens=usage.output_tokens if usage else 0,
        reasoning_tokens=usage.reasoning_tokens if usage else 0,
        done=not round_tool_calls,
    )

    return LlmRoundOutput(
        content=round_content,
        reasoning=round_reasoning,
        tool_calls=round_tool_calls,
        usage=usage,
    )


@dataclass(frozen=True)
class NoToolRoundAction:
    """What to do after a round with no tool calls."""

    kind: str  # "finish" | "rework" | "fallback" | "degraded" | "retry"
    active_model: str | None = None


def decide_no_tool_round(
    *,
    round_content: str,
    final_content: str,
    content_before_round: str,
    controller: LoopController,
    profile: ModelProfile,
    active_model: str | None,
    annotate_citations: bool,
    citation_sink: list[dict[str, Any]] | None,
    finish_guard_reworks: int,
) -> NoToolRoundAction:
    """Classify a no-tool-call round: finish, finish_guard rework, or empty-response ladder."""
    if round_content:
        reworks = (
            finish_guard(final_content, citation_count=len(citation_sink or []))
            if annotate_citations
            else []
        )
        if reworks and finish_guard_reworks < settings.engine_finish_guard_max_reworks:
            return NoToolRoundAction(kind="rework")
        return NoToolRoundAction(kind="finish")

    fallback_model = profile.fallback_model
    fallback_available = (
        settings.engine_fallback_enabled
        and fallback_model is not None
        and fallback_model != (active_model or profile.model)
    )
    action = controller.empty_response_action(fallback_available=fallback_available)
    if action is Intervention.FALLBACK:
        return NoToolRoundAction(kind="fallback", active_model=fallback_model)
    if action is Intervention.FINALIZE:
        return NoToolRoundAction(kind="degraded")
    return NoToolRoundAction(kind="retry")


def apply_finish_guard_rework(
    *,
    messages: list[LLMMessage],
    sink: EventSink,
    final_content: str,
    content_before_round: str,
    round_idx: int,
    run_id: str,
    annotate_citations: bool,
    citation_sink: list[dict[str, Any]] | None,
    finish_guard_reworks: int,
) -> tuple[str, int]:
    """Discard rejected content, inject steer, return updated content and rework count."""
    reworks = (
        finish_guard(final_content, citation_count=len(citation_sink or []))
        if annotate_citations
        else []
    )
    steer = format_guard_steer(reworks)
    logger.info(
        "engine.finish_guard_rework",
        round=round_idx,
        attempt=finish_guard_reworks + 1,
        issues=len(reworks),
    )
    sink.emit(content_reset())
    messages.append(LLMMessage(role="user", content=steer))
    record_turn_fact(
        NoteFact(
            role="user",
            content=steer,
            reason="finish_guard",
            run_id=run_id,
        ).to_fact()
    )
    return content_before_round, finish_guard_reworks + 1
