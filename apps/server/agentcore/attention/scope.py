"""The ambient turn identity an attention signal needs (云对话多端同权 B2 · L1).

A blocking card is raised deep inside the engine — the approval gate and the
worker escalation channel hold a ``conversation_id`` but no ``user_id`` and no
turn id, and the firehose is addressed *by user*. Threading two more arguments
through every face and every constructor would touch far more surface than the
signal is worth, so the turn publishes its identity here once at the pipeline
entry (the same posture ``captain_transcript`` / ``turn_history`` /
``current_fact_log`` already take for state the faces cannot reach).

``None`` outside a turn (tests, standalone tools, the resolve HTTP request) →
the signal degrades to a no-op rather than guessing an addressee.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AttentionScope:
    """Who to notify, and which conversation / turn the card belongs to."""

    user_id: str
    conversation_id: str
    turn_id: str


current_attention_scope: ContextVar[AttentionScope | None] = ContextVar(
    "current_attention_scope", default=None
)


def bind_attention_scope(
    *, user_id: str, conversation_id: str, turn_id: str
) -> Token[AttentionScope | None]:
    """Publish this turn's attention addressee; reset the token in the caller's finally."""
    return current_attention_scope.set(
        AttentionScope(
            user_id=user_id,
            conversation_id=conversation_id,
            turn_id=turn_id,
        )
    )


def reset_attention_scope(token: Token[AttentionScope | None]) -> None:
    """Restore the previous scope (turn teardown)."""
    current_attention_scope.reset(token)
