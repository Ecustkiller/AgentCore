"""Captain soft gates after a no-tool Return: audit-gate (team-gate is investigation-only)."""

from __future__ import annotations

from collections.abc import Callable

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.loop_controller import LoopController

from .directive import Continue, LoopDirective, Return
from .governance import maybe_inject_audit_gate, should_audit_gate
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
    emit_reset: Callable[[str], None],
) -> tuple[LoopDirective, str | None]:
    """Possibly discard a captain wrap-up draft and inject the audit soft gate.

    Team-gate ``long_content`` (discard long no-tool drafts) was removed; solo-collapse
    defense for early long answers is prompt-side「路由自检」instead. Investigation
    team-gate still injects from the tool-round path in ``governance.py``.

    Returns ``(directive, rolled_back_content)``. ``rolled_back_content`` is
    ``content_before_round`` when a gate fired (caller must assign it to
    ``final_content``); ``None`` when the directive is unchanged.
    """
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
        emit_reset("soft_gate")
        return Continue(), content_before_round
    return directive, None
