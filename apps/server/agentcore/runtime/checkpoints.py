"""User checkpoint coordination — the CEO pausing a turn to ask the user.

The ask_user checkpoint's typed result, settled over the unified interaction
bridge (``runtime/interaction.py``), alongside tool approvals
(``runtime/approvals.py``) and local-workspace ops (``workspace/channel.py``). A
GRANTABLE tool approval carries a one-shot *decision*; a checkpoint carries the
user's answer to a question the CEO raised mid-turn (continue / adjust / stop).

Unlike approvals and ops (pure transport), a checkpoint's question + answer are
journaled onto the assistant message (``messages.runs``; see
``events._JOURNAL_EVENT_TYPES``) so a reload replays the exchange inline — it is
part of the conversation, not just gating.

State is in-process (single-worker posture, same as the approval gate); front
with Redis to scale to multiple workers (see ``config.py``).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class CheckpointDecision(StrEnum):
    """How the user (or a timeout) settled a checkpoint the CEO raised."""

    CONTINUE = "continue"  # proceed with the CEO's proposed direction
    ADJUST = "adjust"  # steer the CEO with a note, then continue
    STOP = "stop"  # end this turn gracefully
    TIMEOUT = "timeout"  # no answer within the deadline (engine-set, never user-set)


@dataclass
class CheckpointResponse:
    """The settled outcome of a checkpoint: a decision + an optional note.

    ``note`` carries the user's steer for ``ADJUST`` (and an optional closing
    remark for ``STOP``); it is empty for ``CONTINUE`` / ``TIMEOUT``.
    """

    decision: CheckpointDecision
    note: str = ""
