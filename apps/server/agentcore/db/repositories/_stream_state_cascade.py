"""Cascade-delete helpers for ``turn_stream_state`` rows.

In-flight stream snapshots have no DB foreign key. The live path already drops
them after finalize / salvage / pause; conversation hard-delete and message
delete must drop the matching rows in the *same* transaction or they orphan
(TOAST bloat). Centralized here so the three delete paths — conversation
``hard_delete``, message ``delete_after``, message ``delete_by_id`` — cascade
identically. A future delete path calls one of these instead of re-inlining
``delete(TurnStreamStateRow)``.

The table is keyed by ``turn_id`` (== assistant ``message_id``) and has no
``conversation_id``, so every helper scopes through ``messages`` (IDOR-safe).
Call **before** the messages themselves are deleted, or the subquery is empty.

None of these commit; the calling repository commits the surrounding unit of
work, so the cascade stays atomic with the row delete it accompanies.
"""

from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.db.models import Message, TurnStreamStateRow


async def delete_stream_state_for_conversation(
    session: AsyncSession, conversation_id: str
) -> None:
    """Drop every in-flight snapshot whose turn is a message of this conversation."""
    await session.execute(
        delete(TurnStreamStateRow).where(
            TurnStreamStateRow.turn_id.in_(
                select(Message.id).where(Message.conversation_id == conversation_id)
            )
        )
    )


async def delete_stream_state_after(
    session: AsyncSession, conversation_id: str, *, after_created_at: datetime
) -> None:
    """Drop snapshots of a conversation's messages created strictly after a point."""
    await session.execute(
        delete(TurnStreamStateRow).where(
            TurnStreamStateRow.turn_id.in_(
                select(Message.id).where(
                    Message.conversation_id == conversation_id,
                    Message.created_at > after_created_at,
                )
            )
        )
    )


async def delete_stream_state_for_message(
    session: AsyncSession, conversation_id: str, message_id: str
) -> None:
    """Drop one message's snapshots, conversation-scoped so a cross-tenant id
    touches nothing."""
    await session.execute(
        delete(TurnStreamStateRow).where(
            TurnStreamStateRow.turn_id.in_(
                select(Message.id).where(
                    Message.id == message_id,
                    Message.conversation_id == conversation_id,
                )
            )
        )
    )
