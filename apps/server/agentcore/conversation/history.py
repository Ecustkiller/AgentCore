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
