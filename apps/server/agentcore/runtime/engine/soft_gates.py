"""Captain wrap-up hook.

Debate-commitment / long-form audit gates and tool-failure system
mutation are withdrawn — tool receipts and synthesis facts own those paths.
"""

from __future__ import annotations

from collections.abc import Callable

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.loop_controller import LoopController

from .directive import LoopDirective, Return
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
    """No-op wrap-up. Never discards a captain draft.

    ``controller`` / ``messages`` / ``role`` / ``round_idx`` / ``run_id`` /
    ``content_before_round`` / ``emit_reset`` kept so call sites stay stable.
    """
    del controller, messages, role, round_idx, run_id, content_before_round, emit_reset
    if not isinstance(directive, Return) or not outcome.content:
        return directive, None
    return directive, None
