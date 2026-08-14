"""User-owned state changes pushed to every install of that account.

Some facts belong to the *user*, not to the turn anybody happens to be watching:
their send queue, the decision cards still waiting on them. They change in one
conversation while the desktop sits in another, or on one machine while a second
one is open — and the conversation display stream can carry neither, because a
client only ever subscribes to the conversation it is showing (one idle SSE per
visited conversation would drain the pool).

The device fulfill channel already is what those facts need: one connection per
online install, opened for the account rather than for a conversation, and its
wire body is a plain ``{type, payload}`` dict. So the state rides it, and every
online install lands the same frame regardless of what it is displaying.

These are **facts, not signals**: the payload carries the whole answer (the
queue snapshot, the settled card's decision, which conversations are still
running), so no client has to turn around and GET anything. That is the point —
the reads it replaces were reconciliation passes fired on conversation switch
and stream reconnect, guessing at when they might have missed something.

Deliberately not :class:`SSEEvent`s: they are not journaled, not folded, and
never ride a display stream (same posture as ``client_tool_cancelled``).
"""

from __future__ import annotations

from typing import Any, Literal

from agentcore.core.logging import get_logger
from agentcore.fulfill.hub import default_fulfiller_hub

logger = get_logger(__name__)

# The conversation's whole pending queue, after any change to it.
FRAME_QUEUE_SNAPSHOT = "turn_queue_snapshot"

# Connect-time seed: every pending queue this account still holds (client replace).
# Empty ``queues: []`` is still pushed — silence is not "nothing queued".
FRAME_QUEUE_ACCOUNT_SNAPSHOT = "turn_queue_account_snapshot"

# A durable decision card was consumed — by another device, or in a conversation
# this install is not watching.
FRAME_PAUSED_CARD_SETTLED = "paused_card_settled"

# Account-level「哪些云对话还在跑」: connect seed (client replace) + incremental.
# Rides GET /v1/fulfill — not /v1/realtime, not ai_attention, not FCM.
FRAME_TURN_ACTIVITY_SNAPSHOT = "ai_turn_activity_snapshot"
FRAME_TURN_ACTIVITY = "ai_turn_activity"

# Account-level「哪些对话停着等你」: connect seed (client replace) + incremental.
# Incremental may still ride /v1/realtime during the transition; replace only
# recognizes this fulfill snapshot. No FCM, no field-semantic expansion.
FRAME_ATTENTION_SNAPSHOT = "ai_attention_snapshot"
FRAME_ATTENTION = "ai_attention"

TurnActivityDoneReason = Literal["completed", "paused", "stopped", "error"]
_DONE_REASONS: frozenset[str] = frozenset(
    {"completed", "paused", "stopped", "error"}
)


def queue_snapshot_frame(
    conversation_id: str, items: list[dict[str, Any]]
) -> dict[str, Any]:
    """The wire frame for one conversation's pending queue (incremental)."""
    return {
        "type": FRAME_QUEUE_SNAPSHOT,
        "payload": {"conversation_id": conversation_id, "items": items},
    }


def queue_account_snapshot_frame(
    queues: list[dict[str, Any]],
) -> dict[str, Any]:
    """Connect-time seed: the account's pending queues as one replace frame."""
    return {
        "type": FRAME_QUEUE_ACCOUNT_SNAPSHOT,
        "payload": {"queues": list(queues)},
    }


def push_queue_snapshot(
    *, user_id: str, conversation_id: str, items: list[dict[str, Any]]
) -> int:
    """Push this conversation's full pending queue to the user's devices.

    Sent after every mutation (enqueue, drain, cancel, clear) — including the one
    that empties it, which is how a client learns the last entry is gone. The
    positions are recomputed here, so no client has to renumber what is left.

    Incremental only: never used to wipe the account's whole table. Connect seed
    is :func:`queue_account_snapshot_frame`.
    """
    if not user_id or not conversation_id:
        return 0
    delivered = default_fulfiller_hub().broadcast(
        user_id, queue_snapshot_frame(conversation_id, items)
    )
    logger.info(
        "fulfill.queue_snapshot_pushed",
        user=user_id,
        conversation_id=conversation_id,
        items=len(items),
        devices=delivered,
    )
    return delivered


def push_paused_card_settled(
    *,
    user_id: str,
    conversation_id: str,
    message_id: str,
    checkpoint_id: str,
    kind: str,
    decision: str,
    decided_at: str,
) -> int:
    """Tell the user's devices that this paused card has been continued.

    Whoever consumed the frame is now running the turn, so the card is no longer
    actionable anywhere. Payload mirrors the ``resume_settled`` ack a resuming
    client gets on its own connection — same facts, same reading: what was
    decided and when, never who decided it.
    """
    if not user_id or not checkpoint_id:
        return 0
    delivered = default_fulfiller_hub().broadcast(
        user_id,
        {
            "type": FRAME_PAUSED_CARD_SETTLED,
            "payload": {
                "conversation_id": conversation_id,
                "message_id": message_id,
                "checkpoint_id": checkpoint_id,
                "kind": kind,
                "decision": decision,
                "decided_at": decided_at,
                # The continuation starts as this lands; a device that is not
                # watching has nothing to close out either way.
                "turn_status": "running",
            },
        },
    )
    logger.info(
        "fulfill.paused_card_settled_pushed",
        user=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        devices=delivered,
    )
    return delivered


def turn_activity_snapshot_frame(running: list[str]) -> dict[str, Any]:
    """Connect-time seed: the account's currently-running cloud conversations."""
    return {
        "type": FRAME_TURN_ACTIVITY_SNAPSHOT,
        "payload": {"running": list(running)},
    }


def turn_activity_frame(
    conversation_id: str,
    state: Literal["running", "done"],
    *,
    reason: TurnActivityDoneReason | None = None,
) -> dict[str, Any]:
    """Incremental activity: ``running`` has no reason; ``done`` must carry one."""
    payload: dict[str, Any] = {"conversation_id": conversation_id, "state": state}
    if state == "done":
        payload["reason"] = reason
    return {"type": FRAME_TURN_ACTIVITY, "payload": payload}


def push_turn_activity_running(*, user_id: str, conversation_id: str) -> int:
    """Tell the user's devices this conversation just became a live turn."""
    if not user_id or not conversation_id:
        return 0
    delivered = default_fulfiller_hub().broadcast(
        user_id, turn_activity_frame(conversation_id, "running")
    )
    logger.info(
        "fulfill.turn_activity_pushed",
        user=user_id,
        conversation_id=conversation_id,
        state="running",
        devices=delivered,
    )
    return delivered


def push_turn_activity_done(
    *,
    user_id: str,
    conversation_id: str,
    reason: TurnActivityDoneReason,
) -> int:
    """Tell the user's devices this conversation's slot is empty."""
    if not user_id or not conversation_id or reason not in _DONE_REASONS:
        return 0
    delivered = default_fulfiller_hub().broadcast(
        user_id, turn_activity_frame(conversation_id, "done", reason=reason)
    )
    logger.info(
        "fulfill.turn_activity_pushed",
        user=user_id,
        conversation_id=conversation_id,
        state="done",
        reason=reason,
        devices=delivered,
    )
    return delivered


def attention_snapshot_frame(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Connect-time seed: the account's currently-waiting cards (client replace)."""
    return {
        "type": FRAME_ATTENTION_SNAPSHOT,
        "payload": {"entries": list(entries)},
    }


def attention_frame(
    *,
    state: Literal["required", "resolved"],
    conversation_id: str,
    turn_id: str,
    interaction_id: str,
    kind: str,
    title: str,
) -> dict[str, Any]:
    """Incremental attention: same fields as the realtime signal, wrapped in payload."""
    return {
        "type": FRAME_ATTENTION,
        "payload": {
            "state": state,
            "conversation_id": conversation_id,
            "turn_id": turn_id,
            "interaction_id": interaction_id,
            "kind": kind,
            "title": title,
        },
    }


def push_attention(
    *,
    user_id: str,
    state: Literal["required", "resolved"],
    conversation_id: str,
    turn_id: str,
    interaction_id: str,
    kind: str,
    title: str,
) -> int:
    """Fan one attention transition to the user's fulfill devices."""
    if not user_id or not conversation_id or not interaction_id:
        return 0
    if state not in ("required", "resolved"):
        return 0
    delivered = default_fulfiller_hub().broadcast(
        user_id,
        attention_frame(
            state=state,
            conversation_id=conversation_id,
            turn_id=turn_id,
            interaction_id=interaction_id,
            kind=kind,
            title=title,
        ),
    )
    logger.info(
        "fulfill.attention_pushed",
        user=user_id,
        conversation_id=conversation_id,
        interaction_id=interaction_id,
        state=state,
        devices=delivered,
    )
    return delivered
