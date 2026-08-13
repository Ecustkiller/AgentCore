"""What a cold ``POST .../resume`` actually hit when the paused frame was gone.

A resume that finds no ``paused_turns`` row is not automatically an error: the frame
is *supposed* to disappear the moment somebody continues the turn (``claim`` is
DELETE ... RETURNING). The same card can legitimately be submitted twice — a
double-click, a second device holding the same cold card, a retry after a dropped
SSE — and the second submit must not be told the turn never existed.

The judge is the row the frame's consumer left behind (``paused_turn_outcomes``),
written inside the transaction that consumed the frame:

- ``settled`` ⇒ someone continued the turn; the row carries THEIR decision, moment,
  ``checkpoint_id`` and 结算方 — which is the point. The old judge was the last
  ``*_resolved`` in ``turn_journal``, and on the claim-race path that entry is
  usually the *loser's* own prewrite, so the loser was shown its own decision while
  the winner's ran;
- ``expired`` ⇒ the 7-day TTL sweep pruned an abandoned pause;
- no row ⇒ the turn itself was regenerated / deleted (the outcome is cascaded away
  with the message), or never existed here at all.

``turn_status`` is a separate question — where the TURN stands, not how the card
ended — and it is read from the assistant row's ``usage.status``. Deliberately not
from any process-local run registry: the client decides whether to close out its
streaming bubble on this field, and one worker's registry knows nothing about a
continuation running in another.

Callers on the *claim* path must confirm the frame is really gone before consulting
this module: ``claim`` also answers ``None`` on a DB fault, and a claim that merely
failed is not a card somebody else settled.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from agentcore.core.message_merge import (
    MESSAGE_STATUS_COMPLETE,
    MESSAGE_STATUS_FAILED,
    MESSAGE_STATUS_INCOMPLETE,
    MESSAGE_STATUS_RUNNING,
)
from agentcore.db.base import async_session_factory
from agentcore.db.models import PAUSED_TURN_EXPIRED, PAUSED_TURN_SETTLED
from agentcore.db.repositories import MessageRepository, PausedTurnRepository

_KNOWN_TURN_STATUSES = frozenset(
    {
        MESSAGE_STATUS_RUNNING,
        MESSAGE_STATUS_COMPLETE,
        MESSAGE_STATUS_INCOMPLETE,
        MESSAGE_STATUS_FAILED,
    }
)

ResumeMissKind = Literal["settled", "expired", "regenerated"]
TurnStatus = Literal["running", "complete", "incomplete", "failed", "unknown"]


@dataclass(frozen=True, slots=True)
class ResumeMiss:
    """Why a resume found no frame, plus the settled facts when there are any."""

    kind: ResumeMissKind
    card_kind: str = ""
    checkpoint_id: str = ""
    decision: str = ""
    decided_at: str = ""
    turn_status: TurnStatus = "unknown"
    # 结算方 — the origin device that settled the card ("" when the settler had none,
    # or for a disposition no device drove). Not on the wire: the ack frame states
    # what was decided and when, and does not claim WHO on the user's behalf.
    settled_by: str = ""


def _turn_status_of(usage: Any) -> TurnStatus:
    status = usage.get("status") if isinstance(usage, dict) else None
    if isinstance(status, str) and status in _KNOWN_TURN_STATUSES:
        return status  # type: ignore[return-value]
    return "unknown"


def _iso(value: Any) -> str:
    """The stamped moment as the wire's UTC ISO-8601 string (empty when unset).

    A naive stamp is read as UTC — every writer of this column stamps ``now(UTC)``.
    """
    if not isinstance(value, datetime):
        return ""
    at = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return at.isoformat().replace("+00:00", "Z")


async def classify_resume_miss(*, conversation_id: str, message_id: str) -> ResumeMiss:
    """Decide whether a missing paused frame means「已被处理」or「真失效」.

    Both reads are conversation-scoped (IDOR-safe): a ``message_id`` from another
    conversation matches nothing and reads as a turn that no longer exists. DB faults
    propagate — a resume must never report a decision it could not actually verify.
    """
    async with async_session_factory() as db:
        outcome = await PausedTurnRepository(db).get_outcome(
            message_id, conversation_id=conversation_id
        )
        message = await MessageRepository(db).get_by_id(
            message_id, conversation_id=conversation_id
        )
    turn_status = _turn_status_of(message.usage) if message is not None else "unknown"

    if outcome is None:
        # Nothing consumed this frame and left a conclusion, so there is no card here
        # to answer for — the turn was regenerated / deleted (its outcome went with the
        # message), or the id never named a pause in this conversation.
        return ResumeMiss(kind="regenerated", turn_status=turn_status)
    if outcome.outcome == PAUSED_TURN_EXPIRED:
        return ResumeMiss(kind="expired", turn_status=turn_status)
    if outcome.outcome != PAUSED_TURN_SETTLED:
        # An outcome this build does not understand is not a decision it may report.
        return ResumeMiss(kind="regenerated", turn_status=turn_status)
    return ResumeMiss(
        kind="settled",
        card_kind=outcome.card_kind,
        checkpoint_id=outcome.checkpoint_id,
        decision=outcome.decision,
        decided_at=_iso(outcome.decided_at),
        turn_status=turn_status,
        settled_by=outcome.settled_by,
    )
