"""Tool-call arm of a ReAct round: execute tools, absorb ask_user, govern."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any

from agentcore.core.types import ToolEffect
from agentcore.llm.provider.protocol import LLMMessage, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import EventSink, FinishReason
from agentcore.runtime.loop_controller import LoopController
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

from .ask_user_absorb import (
    absorb_blocking_ask_user_content,
    prepare_blocking_ask_user_tool_calls,
)
from .directive import LoopDirective, Return
from .escalation_gate import apply_escalation_gate
from .governance import (
    apply_circuit_breaker,
    govern_after_tools,
    note_delegate_batches,
    resolve_openai_tool_defs,
)
from .outcome import RoundOutcome
from .tool_exec import execute_tools


@dataclass
class ToolRoundResult:
    """Outcome of the tool-call arm for one ReAct round."""

    outcome: RoundOutcome
    directive: LoopDirective
    final_content: str
    total_usage: TokenUsage
    # Set when the round continues after tools (circuit breaker may have refreshed).
    # ``None`` means leave the caller's ``tool_defs`` unchanged (terminal Return).
    tool_defs: list[dict[str, Any]] | None = None
    tool_defs_changed: bool = False


async def handle_tool_calls_round(
    *,
    outcome: RoundOutcome,
    messages: list[LLMMessage],
    tools: ToolRegistry,
    tool_context: ToolContext,
    sink: EventSink,
    approval_gate: ApprovalGate | None,
    citation_sink: list[dict[str, Any]] | None,
    annotate_citations: bool,
    run_id: str,
    role: str,
    gate_escalation_sink: list[dict[str, Any]] | None,
    deliverable_only: bool,
    on_reset: Callable[[str], None] | None,
    emit_reset: Callable[[str], None],
    content_before_round: str,
    final_content: str,
    round_result_content: str,
    total_usage: TokenUsage,
    controller: LoopController,
    allowed_tool_names: list[str] | None,
    disabled_tools: set[str],
    round_idx: int,
) -> ToolRoundResult:
    """Execute tools for a round that produced tool calls; return next directive."""
    tool_calls = prepare_blocking_ask_user_tool_calls(
        outcome.tool_calls,
        outcome.content or "",
    )
    messages.append(
        LLMMessage(
            role="assistant",
            content=outcome.content or None,
            tool_calls=tool_calls,
            reasoning_content=outcome.reasoning or None,
        )
    )
    tool_results, terminal, attempts = await execute_tools(
        tool_calls,
        tools,
        tool_context,
        sink,
        approval_gate=approval_gate,
        citation_sink=citation_sink,
        annotate_citations=annotate_citations,
        run_id=run_id,
        role=role,
    )
    messages.extend(tool_results)
    if gate_escalation_sink is not None and role == "worker":
        apply_escalation_gate(
            attempts=attempts,
            tool_results=tool_results,
            sink=sink,
            run_id=run_id,
            agent_id=tool_context.agent_id,
            gate_escalation_sink=gate_escalation_sink,
        )
    outcome = replace(
        outcome,
        tool_results=tool_results,
        attempts=attempts,
        terminal_handoff=(terminal.final_text or "") if terminal is not None else None,
    )

    if terminal is not None:
        if absorb_blocking_ask_user_content(
            messages=messages,
            tool_calls=tool_calls,
            attempts=attempts,
            terminal_effect=terminal.effect,
            emit_reset=emit_reset,
        ):
            final_content = content_before_round
        usage_meta = terminal.metadata or {}
        total_usage = total_usage + TokenUsage(
            input_tokens=usage_meta.get("input_tokens", 0),
            output_tokens=usage_meta.get("output_tokens", 0),
            reasoning_tokens=usage_meta.get("reasoning_tokens", 0),
            cache_hit_tokens=usage_meta.get("cache_hit_tokens", 0),
            cache_miss_tokens=usage_meta.get("cache_miss_tokens", 0),
        )
        # 挂起即收口 (②): a SUSPEND terminal ended the turn at a durable
        # checkpoint awaiting /resume — NOT because an answer was produced.
        # Stamp FinishReason.PAUSED (via finish_override_sink) so the pipeline
        # emits a paused message_end and the persist tail parks the turn (the
        # frame is its record). INTERACT / HANDOFF carry their final_text and
        # finish on the default reason (finish_reason=None).
        paused = terminal.effect is ToolEffect.SUSPEND
        directive: LoopDirective = Return(
            finish_reason=FinishReason.PAUSED if paused else None,
            extra_content=outcome.terminal_handoff or "",
        )
        return ToolRoundResult(
            outcome=outcome,
            directive=directive,
            final_content=final_content,
            total_usage=total_usage,
        )

    # 交付正文只留最终交付、旁白入 journal (Fork-B): this round wrote prose
    # and then called a NON-terminal tool, so that prose is process
    # narration (a lead-in, or an acknowledgement of an injected
    # [系统提示] steer such as「谢谢指正，我重新整理」), not deliverable. Roll it
    # back off final_content — it already streamed live + was journaled this
    # round (llm_call fact) — mirroring the finish_guard Rework rollback, so
    # only the FINAL answer round's text reaches the persisted product.
    if deliverable_only and round_result_content:
        # A run whose LIVE display shares the deliverable channel (worker /
        # debater / revision: on_reset routes run_output_reset, and the card
        # replays from the message_final fact) must also clear the streamed
        # narration off its card, so 直播 == the rolled-back deliverable ==
        # 重载 (合成自 message_final) — the conformance invariant. The CEO
        # streams to a SEPARATE process timeline (on_reset is None): its
        # narration stays visible there (透明可见), only its persisted content
        # (messages.content, 旁路 conformance) is trimmed.
        if on_reset is not None:
            emit_reset("narration")
        final_content = content_before_round
    controller.record(outcome.attempts)
    # Mark post-delegate mode if delegate was called
    note_delegate_batches(controller, tool_calls, outcome.attempts)
    tool_defs = resolve_openai_tool_defs(tools, allowed_tool_names, disabled_tools)
    breaker = apply_circuit_breaker(
        controller,
        messages=messages,
        run_id=run_id,
        round_idx=round_idx,
        disabled_tools=disabled_tools,
    )
    if breaker.refresh_tool_defs:
        tool_defs = resolve_openai_tool_defs(tools, allowed_tool_names, disabled_tools)
    directive = govern_after_tools(
        outcome,
        controller,
        messages=messages,
        round_idx=round_idx,
        run_id=run_id,
        breaker_message=breaker.message,
        role=role,
    )
    return ToolRoundResult(
        outcome=outcome,
        directive=directive,
        final_content=final_content,
        total_usage=total_usage,
        tool_defs=tool_defs,
        tool_defs_changed=True,
    )
