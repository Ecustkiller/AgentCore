"""ReAct loop convergence governance: investigation classification, circuit breaker, nudges."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.config import ModelProfile
from agentcore.llm.protocol import LLMMessage
from agentcore.runtime.events import FinishReason
from agentcore.runtime.facts import NoteFact, record_turn_fact
from agentcore.runtime.loop_controller import (
    Intervention,
    LoopController,
    progress_review_prompt,
)
from agentcore.tools.registry import ToolRegistry

from .directive import Continue, Finalize, LoopDirective, Return, SwitchModel
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


def decide_llm_failure(
    *,
    profile: ModelProfile,
    active_model: str | None,
    final_content: str,
) -> LoopDirective:
    """Pick the directive for a round whose LLM call hard-failed (non-raising path).

    The provider already exhausted its own network retries (429/5xx backoff) before
    the exception escaped, so retrying the SAME model is pointless. Escalate to the
    profile's fallback model once — a different model may be healthy — sharing the
    one-switch budget with the empty-response ladder via the ``active_model`` gate.
    When no fallback is available (unconfigured, disabled, or already in use), end the
    turn on an honest terminal reason: ``ERROR`` when nothing was produced, ``DEGRADED``
    when partial content already streamed (don't discard a partial answer).
    """
    fallback_model = profile.fallback_model
    fallback_available = (
        settings.engine_fallback_enabled
        and fallback_model is not None
        and fallback_model != (active_model or profile.model)
    )
    if fallback_available:
        assert fallback_model is not None  # fallback_available ⇒ a model exists
        logger.warning("engine.fallback_model_on_error", fallback_model=fallback_model)
        return SwitchModel(model=fallback_model)

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
