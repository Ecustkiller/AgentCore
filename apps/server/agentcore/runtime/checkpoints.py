"""User checkpoint coordination — the CEO pausing a turn to ask the user.

The ask_user checkpoint's typed result, settled over the unified interaction
bridge (``runtime/interaction.py``), alongside tool approvals
(``runtime/approvals.py``) and local-workspace ops (``workspace/channel.py``). A
GRANTABLE tool approval carries a one-shot *decision*; a checkpoint carries the
user's answer to a question the CEO raised mid-turn (continue / adjust / stop).

Unlike approvals and ops (pure transport), a checkpoint's question + answer are
journaled to the turn_journal table (see ``events._JOURNAL_EVENT_TYPES``) and
projected into the assistant message's runs payload, so a reload replays the
exchange inline — it is part of the conversation, not just gating.

State is in-process (single-worker posture, same as the approval gate); front
with Redis to scale to multiple workers (see ``config.py``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal

AskCheckpointIntent = Literal["kickoff", "decision"]


class CheckpointDecision(StrEnum):
    """How the user (or a timeout) settled a checkpoint the CEO raised."""

    CONTINUE = "continue"  # proceed with the CEO's proposed direction
    ADJUST = "adjust"  # steer the CEO with a note, then continue
    STOP = "stop"  # end this turn gracefully
    TIMEOUT = "timeout"  # no answer within the deadline (engine-set, never user-set)


@dataclass
class CheckpointResponse:
    """The settled outcome of a checkpoint: a decision + an optional note + picks.

    ``note`` carries the user's steer for ``ADJUST`` (and an optional closing
    remark for ``STOP``); it is empty for ``CONTINUE`` / ``TIMEOUT``. ``selected``
    holds the option(s) the user picked from the CEO's ``options`` menu — one for a
    single-select ask, several when the ask is ``multiple`` — and is a first-class
    part of the answer (no longer folded into ``note``), so ``CONTINUE`` carries the
    pick too. Empty when the ask offered no options or the user chose none.
    """

    decision: CheckpointDecision
    note: str = ""
    selected: list[str] = field(default_factory=list)
