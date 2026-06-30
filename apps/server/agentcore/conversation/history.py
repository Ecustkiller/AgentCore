"""History reconstruction and replay.

Loads conversation history from the database for LLM context injection.
Only user/assistant text messages are replayed — tool I/O is not included
to avoid burning tokens on cross-turn accumulated tool output.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.db.repositories import ConversationRepository, MessageRepository


async def load_recent_history(
    session: AsyncSession,
    conversation_id: str,
    *,
    max_messages: int = 40,
) -> list[dict]:
    """Load the MOST RECENT ``max_messages``, in chronological order.

    Returns a list of {role, content} dicts (oldest-first within the window).
    Only user and assistant messages are included.

    Tails the conversation on purpose — a long chat must feed the LLM its
    LATEST turns, not its opening (the earlier ``load_history`` paged the OLDEST
    ``max_messages`` via ``list_by_conversation(offset=0)``, so a >40-message
    conversation silently dropped every recent turn). Shared by two readers:
    the per-turn LLM context (conversation/service.py) and the offline long-term
    memory consolidation window (memory/consolidation.py).
    """
    repo = MessageRepository(session)
    messages = await repo.list_recent(conversation_id, limit=max_messages)

    history = []
    for msg in messages:
        if msg.role in ("user", "assistant") and msg.content:
            history.append({"role": msg.role, "content": msg.content})

    return history


def _summary_block(summary: str) -> dict:
    """The rolling compaction summary as ONE assistant-role history item.

    Assistant (not user) so it slots between the system prompt and the first real
    user turn without two consecutive user messages; framed so the model reads it as
    a system-made recap of earlier context, not the user's words.
    """
    return {
        "role": "assistant",
        "content": (
            "（以下是本次对话早前内容的摘要，由系统自动压缩以控制上下文长度；"
            "需要更早的精确原文时，可基于此摘要继续。）\n\n" + summary.strip()
        ),
    }


async def load_chat_context(
    session: AsyncSession,
    conversation_id: str,
    *,
    max_messages: int = 40,
) -> list[dict]:
    """The CEO chat window: the rolling compaction summary (when present) prefixed to
    the un-folded recent tail; otherwise just the plain recent window.

    Same ``[{role, content}]`` shape as :func:`load_recent_history`, so the pipeline is
    unchanged — this only swaps WHAT fills the window. When the conversation has a
    summary, the tail is everything strictly newer than the watermark (recent-biased
    and capped, so a stalled compaction degrades by dropping the oldest un-folded tail,
    never the newest — see ``MessageRepository.list_recent_after``). The summary rides
    as the FIRST item (assistant block) right after the system prompt, keeping the
    stable system prefix cached and re-caching only summary+tail when a re-compaction
    changes the summary (执行引擎架构设计 §三 长对话压缩).

    NB: long-term memory consolidation deliberately still reads raw recent messages via
    :func:`load_recent_history` — it reconciles ACTUAL turns into the memory file and
    must not see a synthetic summary block.
    """
    conv = await ConversationRepository(session).get_by_id(conversation_id)
    if conv is not None and conv.compaction_summary and conv.compacted_through:
        rows = await MessageRepository(session).list_recent_after(
            conversation_id,
            after=conv.compacted_through,
            limit=settings.compaction_context_max_messages,
        )
        history: list[dict] = [_summary_block(conv.compaction_summary)]
        for msg in rows:
            if msg.role in ("user", "assistant") and msg.content:
                history.append({"role": msg.role, "content": msg.content})
        return history

    return await load_recent_history(session, conversation_id, max_messages=max_messages)
