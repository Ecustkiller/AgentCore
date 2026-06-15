"""History reconstruction and replay.

Loads conversation history from the database for LLM context injection.
Only user/assistant text messages are replayed — tool I/O is not included
to avoid burning tokens on cross-turn accumulated tool output.
"""


from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.db.repositories import MessageRepository


async def load_history(
    session: AsyncSession,
    conversation_id: str,
    *,
    max_messages: int = 40,
) -> list[dict]:
    """Load recent messages for LLM context.

    Returns a list of {role, content} dicts in chronological order.
    Only user and assistant messages are included.
    """
    repo = MessageRepository(session)
    messages, _total = await repo.list_by_conversation(
        conversation_id, limit=max_messages
    )

    history = []
    for msg in messages:
        if msg.role in ("user", "assistant") and msg.content:
            history.append({"role": msg.role, "content": msg.content})

    return history


async def load_recent_history(
    session: AsyncSession,
    conversation_id: str,
    *,
    max_messages: int = 40,
) -> list[dict]:
    """Load the MOST RECENT messages, chronological order ({role, content} dicts).

    Unlike ``load_history`` (the oldest ``max_messages``), this tails the
    conversation — the window the offline long-term-memory consolidation reconciles
    against the existing memory (memory/consolidation.py). Only user/assistant text.
    """
    repo = MessageRepository(session)
    messages = await repo.list_recent(conversation_id, limit=max_messages)

    history = []
    for msg in messages:
        if msg.role in ("user", "assistant") and msg.content:
            history.append({"role": msg.role, "content": msg.content})

    return history
