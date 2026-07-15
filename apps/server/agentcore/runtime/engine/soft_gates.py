"""Captain soft gates after a no-tool Return: team-gate and audit-gate."""

from __future__ import annotations

from collections.abc import Callable

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.loop_controller import LoopController

from .directive import Continue, LoopDirective, Return
from .governance import (
    maybe_inject_audit_gate,
    maybe_inject_team_gate,
    should_audit_gate,
    should_team_gate_long_content,
)
from .outcome import RoundOutcome


def maybe_soft_gate_no_tool_return(
    *,
    directive: LoopDirective,
    outcome: RoundOutcome,
    controller: LoopController,
    messages: list[LLMMessage],
    role: str,
    round_idx: int,
    run_id: str,
    content_before_round: str,
    emit_reset: Callable[[], None],
) -> tuple[LoopDirective, str | None]:
    """Possibly discard a captain wrap-up draft and inject a soft gate.

    Returns ``(directive, rolled_back_content)``. ``rolled_back_content`` is
    ``content_before_round`` when a gate fired (caller must assign it to
    ``final_content``); ``None`` when the directive is unchanged.
    """
    if (
        isinstance(directive, Return)
        and outcome.content
        and should_team_gate_long_content(
            controller,
            role=role,
            round_idx=round_idx,
            content=outcome.content,
        )
        and maybe_inject_team_gate(
            controller,
            messages=messages,
            run_id=run_id,
            round_idx=round_idx,
            role=role,
            trigger="long_content",
        )
    ):
        emit_reset()
        return Continue(), content_before_round
    if (
        isinstance(directive, Return)
        and outcome.content
        and should_audit_gate(controller, role=role)
        and maybe_inject_audit_gate(
            controller,
            messages=messages,
            run_id=run_id,
            round_idx=round_idx,
            role=role,
        )
    ):
        emit_reset()
        return Continue(), content_before_round
    return directive, None
