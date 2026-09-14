"""Cross-turn retry stamp for tool metadata / ``ToolCallFact``.

Answers: 跨回合同一动作还值不值得再试. Distinct from loop-controller
``error_class``, which answers: 本轮还该不该继续用这个工具/这条路. Do not
merge the two — e.g. ``liveness_timeout`` is in-turn ``permanent`` (stop
using this tool this round) but cross-turn ``not_futile`` (the next turn
may succeed).

Three-state: ``futile`` / ``not_futile`` / omitted. Unknown must be omitted
— never default, never guess. This field is a recorded fact, not a gate.

Authority lives here so leaf tools do not import ``runtime.facts``.
"""

from __future__ import annotations

from enum import StrEnum

__all__ = [
    "CROSS_TURN_RETRY_KEY",
    "CrossTurnRetry",
    "cross_turn_retry_meta",
    "normalize_cross_turn_retry",
]


class CrossTurnRetry(StrEnum):
    """Whether repeating the same action on a later turn is futile."""

    FUTILE = "futile"
    NOT_FUTILE = "not_futile"


CROSS_TURN_RETRY_KEY = "cross_turn_retry"


def normalize_cross_turn_retry(raw: object) -> str:
    """Known values only; anything else is unknown (empty → omit)."""
    if isinstance(raw, CrossTurnRetry):
        text = raw.value
    elif isinstance(raw, str):
        text = raw.strip()
    else:
        text = ""
    if text in {CrossTurnRetry.FUTILE.value, CrossTurnRetry.NOT_FUTILE.value}:
        return text
    return ""


def cross_turn_retry_meta(value: CrossTurnRetry) -> dict[str, str]:
    """Stamp for ``ToolResult.metadata`` / ``ToolAttempt.meta`` — never infers."""
    return {CROSS_TURN_RETRY_KEY: value.value}
