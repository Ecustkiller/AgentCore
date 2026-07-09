"""ReAct loop convergence governance: investigation classification, circuit breaker, nudges."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.events import FinishReason
from agentcore.runtime.facts import NoteFact, record_turn_fact
from agentcore.runtime.loop_controller import (
    Intervention,
    LoopController,
    progress_review_prompt,
)
from agentcore.tools.registry import ToolRegistry

from .constants import FINALIZE_COORDINATION_TOOLS, FINALIZE_FORBIDDEN_TOOLS
from .directive import Continue, Finalize, LoopDirective, Return
from .outcome import RoundOutcome

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
        convergence_spin_rounds=settings.engine_convergence_spin_rounds,
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


def resolve_finalize_coordination_tools(
    tools: ToolRegistry,
    allowed_tool_names: list[str] | None,
    disabled_tools: set[str],
) -> list[dict[str, Any]] | None:
    """OpenAI tool defs for a forced-finalize round: coordination tools only."""
    if allowed_tool_names is None:
        candidates = tools.names if tools.count > 0 else []
    else:
        candidates = list(allowed_tool_names)
    coordination = [
        name
        for name in candidates
        if name in FINALIZE_COORDINATION_TOOLS
        and name not in disabled_tools
        and name not in FINALIZE_FORBIDDEN_TOOLS
    ]
    if not coordination:
        return None
    return tools.get_openai_definitions(coordination) or None


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
        from agentcore.runtime.audit.hooks import on_tool_disabled

        for tool_name in breaker.disabled:
            on_tool_disabled(
                tool_name=tool_name,
                run_id=run_id,
                failure_count=controller.tool_failure_count(tool_name),
            )
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


def decide_llm_failure(*, final_content: str) -> LoopDirective:
    reason = FinishReason.DEGRADED if final_content else FinishReason.ERROR
    logger.warning(
        "engine.llm_failed_terminal", reason=reason.value, has_content=bool(final_content)
    )
    return Return(finish_reason=reason)


def govern_after_tools(
    outcome: RoundOutcome,
    controller: LoopController,
    *,
    messages: list[LLMMessage],
    round_idx: int,
    run_id: str,
    breaker_message: str | None,
) -> LoopDirective:
    """Run post-tool convergence governance and return the next directive.

    Steers that keep the loop going (a stuck-loop nudge, a periodic reflection)
    are injected here as side effects on ``messages`` and resolve to ``Continue``;
    a hard stop resolves to ``Finalize`` (the caller forces one tool-free round).
    ``UNPRODUCTIVE`` is stamped via the Finalize directive's ``finish_reason``.
    Convergence and reflection are suppressed when the circuit breaker already
    steered this round (``breaker_message is not None``) so steers don't stack.
    """
    # Post-delegate investigation check (优化六: 委派后工具降级)
    if outcome.has_tool_calls:
        called_tool_names = {a.tool_name for a in outcome.attempts if a.tool_name}
        post_delegate_msg = controller.post_delegate_check(called_tool_names)
        if post_delegate_msg is not None:
            messages.append(LLMMessage(role="user", content=post_delegate_msg))
            record_turn_fact(
                NoteFact(
                    role="user", content=post_delegate_msg, reason="post_delegate", run_id=run_id
                ).to_fact()
            )

    controller.note_round_productivity(
        had_tool_calls=outcome.has_tool_calls,
        all_failed=outcome.all_tools_failed,
        had_content=bool(outcome.content),
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
        return Continue()

    if signal is not None and action is Intervention.FINALIZE:
        logger.warning(
            "engine.loop_finalize",
            reason=signal.reason.value,
            tool=signal.tool_name,
            count=signal.count,
            round=round_idx,
        )
        return Finalize(reason=signal.reason.value)

    if controller.unproductive_early_stop():
        logger.warning(
            "engine.unproductive_stop", round=round_idx, attempts=len(outcome.attempts)
        )
        return Finalize(reason="unproductive", finish_reason=FinishReason.UNPRODUCTIVE)

    if breaker_message is None and controller.convergence_action() is Intervention.FINALIZE:
        logger.warning(
            "engine.convergence_finalize",
            round=round_idx,
            investigation_rounds=controller.investigation_rounds,
            investigation_calls=controller.investigation_calls,
        )
        return Finalize(reason="convergence")

    if breaker_message is None and controller.reflection_due(round_idx):
        review = progress_review_prompt(round_idx + 1)
        logger.info("engine.reflection_inject", round=round_idx)
        messages.append(LLMMessage(role="user", content=review))
        record_turn_fact(
            NoteFact(role="user", content=review, reason="reflection", run_id=run_id).to_fact()
        )

    return Continue()
