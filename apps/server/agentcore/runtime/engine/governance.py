"""ReAct loop convergence governance: investigation classification, circuit breaker, nudges."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.config import ModelProfile
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.protocol import LLMMessage, TokenUsage
from agentcore.runtime.events import FinishReason
from agentcore.runtime.facts import NoteFact, record_turn_fact
from agentcore.runtime.loop_controller import (
    Intervention,
    LoopController,
    progress_review_prompt,
)
from agentcore.tools.registry import ToolRegistry

from .finalize import force_finalize

logger = get_logger(__name__)


def classify_investigation_tools(
    tools: ToolRegistry,
    allowed_tool_names: list[str] | None,
) -> frozenset[str]:
    """Classify read-only info-gathering tools for over-investigation backstop."""
    available_names = (
        set(allowed_tool_names) if allowed_tool_names is not None else set(tools.names)
    )
    schema_by_name = {schema.name: schema for schema in tools.list_all()}
    investigation_tools: set[str] = set()
    for name in available_names:
        schema = schema_by_name.get(name)
        if schema is None:
            continue
        if schema.approval is ToolApproval.NEVER and schema.category in (
            ToolCategory.FILESYSTEM,
            ToolCategory.SEARCH,
            ToolCategory.RESEARCH,
        ):
            investigation_tools.add(name)
    return frozenset(investigation_tools)


def create_loop_controller(investigation_tools: frozenset[str]) -> LoopController:
    """Build per-run convergence controller from engine settings."""
    return LoopController(
        empty_threshold=settings.engine_empty_response_threshold,
        tool_failure_warn=settings.engine_tool_failure_warn,
        tool_failure_disable=settings.engine_tool_failure_disable,
        unproductive_threshold=settings.engine_unproductive_threshold,
        reflection_start_round=settings.engine_reflection_start_round,
        reflection_interval=settings.engine_reflection_interval,
        convergence_finalize_rounds=settings.engine_convergence_finalize_rounds,
        investigation_tools=investigation_tools,
    )


def resolve_openai_tool_defs(
    tools: ToolRegistry,
    allowed_tool_names: list[str] | None,
    disabled_tools: set[str],
) -> list[dict[str, Any]] | None:
    """Resolve OpenAI tool definitions minus circuit-broken tools."""
    if allowed_tool_names is None:
        candidates = tools.names if tools.count > 0 else []
    else:
        candidates = list(allowed_tool_names)
    candidates = [name for name in candidates if name not in disabled_tools]
    if not candidates:
        return None
    return tools.get_openai_definitions(candidates) or None


@dataclass(frozen=True)
class CircuitBreakerOutcome:
    """Result of applying the B2 tool-failure circuit breaker after a tool round."""

    message: str | None
    refresh_tool_defs: bool


def apply_circuit_breaker(
    controller: LoopController,
    *,
    messages: list[LLMMessage],
    run_id: str,
    round_idx: int,
    disabled_tools: set[str],
) -> CircuitBreakerOutcome:
    """Retire wedged tools and inject a steer when the breaker trips."""
    breaker = controller.tool_circuit_breaker()
    refresh = bool(breaker.disabled)
    if breaker.disabled:
        disabled_tools.update(breaker.disabled)
    breaker_message = breaker.message()
    if breaker_message is not None:
        logger.info(
            "engine.tool_circuit_breaker",
            warned=list(breaker.warned),
            disabled=list(breaker.disabled),
            round=round_idx,
        )
        messages.append(LLMMessage(role="user", content=breaker_message))
        record_turn_fact(
            NoteFact(
                role="user",
                content=breaker_message,
                reason="circuit_breaker",
                run_id=run_id,
            ).to_fact()
        )
    return CircuitBreakerOutcome(message=breaker_message, refresh_tool_defs=refresh)


@dataclass(frozen=True)
class LoopExit:
    """Early return from the ReAct loop."""

    content: str
    reasoning: str
    usage: TokenUsage
    rounds: int
    finish_override: FinishReason | None = None


async def govern_after_tools(
    controller: LoopController,
    *,
    messages: list[LLMMessage],
    llm: DeepSeekProvider,
    profile: ModelProfile,
    emit_content: Callable[[str], None],
    emit_reasoning: Callable[[str], None],
    final_content: str,
    final_reasoning: str,
    total_usage: TokenUsage,
    round_idx: int,
    run_id: str,
    breaker_message: str | None,
    attempts: list[Any],
    round_tool_calls: list[Any],
    round_content: str,
    finish_override_sink: list[FinishReason] | None,
) -> LoopExit | None:
    """Run post-tool convergence governance; return LoopExit when the loop should stop."""
    round_all_failed = bool(attempts) and all(not a.success for a in attempts)
    controller.note_round_productivity(
        had_tool_calls=bool(round_tool_calls),
        all_failed=round_all_failed,
        had_content=bool(round_content),
    )

    signal = controller.detect()
    action = controller.decide(signal)
    if signal is not None and action is Intervention.NUDGE:
        logger.info(
            "engine.loop_nudge",
            reason=signal.reason.value,
            tool=signal.tool_name,
            count=signal.count,
            round=round_idx,
        )
        reflection = signal.reflection_message()
        messages.append(LLMMessage(role="user", content=reflection))
        record_turn_fact(
            NoteFact(role="user", content=reflection, reason="nudge", run_id=run_id).to_fact()
        )
        return None

    if signal is not None and action is Intervention.FINALIZE:
        logger.warning(
            "engine.loop_finalize",
            reason=signal.reason.value,
            tool=signal.tool_name,
            count=signal.count,
            round=round_idx,
        )
        content, reasoning, usage, rounds = await force_finalize(
            messages=messages,
            llm=llm,
            profile=profile,
            emit_content=emit_content,
            emit_reasoning=emit_reasoning,
            final_content=final_content,
            final_reasoning=final_reasoning,
            total_usage=total_usage,
            rounds=round_idx + 1,
            reason=signal.reason.value,
            run_id=run_id,
        )
        return LoopExit(content, reasoning, usage, rounds)

    if controller.unproductive_early_stop():
        logger.warning("engine.unproductive_stop", round=round_idx, attempts=len(attempts))
        if finish_override_sink is not None:
            finish_override_sink.append(FinishReason.UNPRODUCTIVE)
        content, reasoning, usage, rounds = await force_finalize(
            messages=messages,
            llm=llm,
            profile=profile,
            emit_content=emit_content,
            emit_reasoning=emit_reasoning,
            final_content=final_content,
            final_reasoning=final_reasoning,
            total_usage=total_usage,
            rounds=round_idx + 1,
            reason="unproductive",
            run_id=run_id,
        )
        return LoopExit(content, reasoning, usage, rounds, FinishReason.UNPRODUCTIVE)

    if breaker_message is None and controller.convergence_action() is Intervention.FINALIZE:
        logger.warning(
            "engine.convergence_finalize",
            round=round_idx,
            investigation_rounds=controller.investigation_rounds,
            investigation_calls=controller.investigation_calls,
        )
        content, reasoning, usage, rounds = await force_finalize(
            messages=messages,
            llm=llm,
            profile=profile,
            emit_content=emit_content,
            emit_reasoning=emit_reasoning,
            final_content=final_content,
            final_reasoning=final_reasoning,
            total_usage=total_usage,
            rounds=round_idx + 1,
            reason="convergence",
            run_id=run_id,
        )
        return LoopExit(content, reasoning, usage, rounds)

    if breaker_message is None and controller.reflection_due(round_idx):
        review = progress_review_prompt(round_idx + 1)
        logger.info("engine.reflection_inject", round=round_idx)
        messages.append(LLMMessage(role="user", content=review))
        record_turn_fact(
            NoteFact(role="user", content=review, reason="reflection", run_id=run_id).to_fact()
        )

    return None
