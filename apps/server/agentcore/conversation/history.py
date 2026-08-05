"""History reconstruction and replay.

Loads conversation history from the database for LLM context injection.
Only user/assistant text messages are replayed — tool I/O is not included
to avoid burning tokens on cross-turn accumulated tool output.

Failed assistant turns (empty content + failed status) are folded into a short
system-framed note so the next turn can attribute prior failures correctly
instead of inventing causes. Error prose stays in the note — never as ordinary
assistant content back to the LLM.
"""

from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.conversation.failure_visible import (
    error_message_from_usage,
    failure_category_label,
    is_failed_empty_assistant,
    usage_of,
)
from agentcore.db.repositories import ConversationRepository, MessageRepository

# Re-export detection helpers for existing tests / callers.
_is_failed_empty_assistant = is_failed_empty_assistant
_failure_category_label = failure_category_label

_DETAIL_CLIP = 120


def _failure_detail(msg: Any) -> str | None:
    """Optional short error_message for the note (category remains primary)."""
    raw = error_message_from_usage(usage_of(msg))
    if not raw:
        return None
    text = raw.strip()
    if len(text) > _DETAIL_CLIP:
        return text[: _DETAIL_CLIP - 1] + "…"
    return text


def _failure_note(categories: list[str], details: list[str] | None = None) -> dict:
    """Merge consecutive failed turns into one short assistant-framed system note.

    Assistant role (not bare system) mirrors the compaction summary block — slots
    cleanly between real turns without stacking multiple system messages mid-chat.
    """
    # Preserve order, drop duplicates for a compact label list.
    seen: set[str] = set()
    unique: list[str] = []
    for c in categories:
        if c not in seen:
            seen.add(c)
            unique.append(c)
    n = len(categories)
    cats = "、".join(unique)
    if n == 1:
        body = (
            f"（系统注记：上一轮 AI 调用失败，未产生有效回复。"
            f"失败原因类别：{cats}。请据此如实说明，不要编造其它原因。）"
        )
    else:
        body = (
            f"（系统注记：此前连续 {n} 轮 AI 调用失败，均未产生有效回复。"
            f"失败原因类别：{cats}。请据此如实说明，不要编造其它原因。）"
        )
    if details:
        # One clipped detail line — still a note, not fake assistant prose.
        seen_d: set[str] = set()
        unique_d: list[str] = []
        for d in details:
            if d and d not in seen_d:
                seen_d.add(d)
                unique_d.append(d)
        if unique_d:
            body = body.removesuffix("）") + f" 详情：{'；'.join(unique_d)}。）"
    return {"role": "assistant", "content": body}


def _fold_history_messages(messages: list[Any]) -> list[dict]:
    """Fold ORM message rows into ``[{role, content}]``, merging consecutive failures."""
    history: list[dict] = []
    pending_failures: list[str] = []
    pending_details: list[str] = []

    def flush_failures() -> None:
        if pending_failures:
            history.append(_failure_note(pending_failures, pending_details))
            pending_failures.clear()
            pending_details.clear()

    for msg in messages:
        role = getattr(msg, "role", None)
        content = getattr(msg, "content", None) or ""
        if role == "user" and content:
            flush_failures()
            history.append({"role": "user", "content": content})
        elif role == "assistant" and content:
            flush_failures()
            item: dict[str, Any] = {"role": "assistant", "content": content}
            # 引擎跨回合 hydrate 用；拼 LLMMessage 时只取 role/content，不带入模型窗口。
            ledger = getattr(msg, "evidence_ledger", None)
            if isinstance(ledger, list) and ledger:
                item["evidence_ledger"] = list(ledger)
            history.append(item)
        elif _is_failed_empty_assistant(msg):
            pending_failures.append(_failure_category_label(msg))
            detail = _failure_detail(msg)
            if detail:
                pending_details.append(detail)
        # else: empty non-failed assistant / other roles — skip
    flush_failures()
    return history


async def load_recent_history(
    session: AsyncSession,
    conversation_id: str,
    *,
    max_messages: int = 40,
    fold_failures: bool = False,
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

    ``fold_failures``: when True (chat prompt path), consecutive empty failed
    assistant turns become one short system note. When False (memory
    consolidation), empty assistants stay dropped so synthetic notes never
    enter the memory file.
    """
    repo = MessageRepository(session)
    messages = await repo.list_recent(conversation_id, limit=max_messages)
    if fold_failures:
        return _fold_history_messages(messages)
    history = []
    for msg in messages:
        if msg.role in ("user", "assistant") and msg.content:
            item: dict[str, Any] = {"role": msg.role, "content": msg.content}
            if msg.role == "assistant":
                ledger = getattr(msg, "evidence_ledger", None)
                if isinstance(ledger, list) and ledger:
                    item["evidence_ledger"] = list(ledger)
            history.append(item)
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
    conv = await ConversationRepository(session).get_by_id_unscoped(conversation_id)
    if conv is not None and conv.compaction_summary and conv.compacted_through:
        rows = await MessageRepository(session).list_recent_after(
            conversation_id,
            after=conv.compacted_through,
            limit=settings.compaction_context_max_messages,
        )
        history: list[dict] = [_summary_block(conv.compaction_summary)]
        history.extend(_fold_history_messages(rows))
        return history

    return await load_recent_history(
        session, conversation_id, max_messages=max_messages, fold_failures=True
    )


async def load_history_for_turn(
    session: AsyncSession,
    conversation_id: str,
    *,
    before_user_created_at: datetime,
    history_len: int,
) -> list[dict]:
    """Reconstruct the prior-turn history spliced into a turn's LLM window head.

    Mirrors ``load_chat_context(...)[:-1]`` at send time: the journal stores only
    ``history_len``; the caller supplies the tail of messages strictly older than the
    triggering user message. When compaction was active before that user message, the
    synthetic summary block counts toward ``history_len``.
    """
    if history_len <= 0:
        return []

    msg_repo = MessageRepository(session)
    rows, _ = await msg_repo.list_before(
        conversation_id,
        before=before_user_created_at,
        limit=max(history_len * 2, 40),
    )

    items: list[dict] = []
    conv = await ConversationRepository(session).get_by_id_unscoped(conversation_id)
    if (
        conv is not None
        and conv.compaction_summary
        and conv.compacted_through
        and conv.compacted_through < before_user_created_at
    ):
        items.append(_summary_block(conv.compaction_summary))

    items.extend(_fold_history_messages(rows))

    if len(items) > history_len:
        return items[-history_len:]
    return items
