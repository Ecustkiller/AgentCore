"""压缩失败之后，早期对话是不是真的从 AI 眼里消失了。

Compaction is best-effort on purpose: a failed pass leaves the watermark untouched
and the turn goes ahead on whatever ``load_chat_context`` can assemble without a
summary. For most chats that costs nothing — the whole thing still fits in the
window. Past the window it costs the conversation's memory: those turns are in no
summary and in no verbatim tail, so the model answers without them while the
transcript on screen still shows every one of them. That mismatch is what a user
experiences as「AI 越聊越忘事」, and it used to be entirely unsaid — one production
account spent a day with folding refused by an exhausted upstream allowance and
learned about it by filing a bug.

What this module decides is only「现在真的看不见了吗」, and only from stored state:

- **no rolling summary** — the fallback window IS the model's whole view of the
  chat (:data:`~agentcore.conversation.history.FALLBACK_CONTEXT_MAX_MESSAGES`), so
  everything older than it is gone;
- **with a summary** — every turn up to the watermark survives *as summary*, and
  nothing is missing until the un-folded tail itself outgrows
  ``compaction_context_max_messages``.

Neither test asks whether a pass failed, which is the point: a conversation whose
folding keeps up trips neither (the message trigger fires ~28 un-folded messages
in, an order of magnitude below both windows), so reaching one of these is itself
the proof that a fold did not happen. *Why* it did not is enrichment rather than
evidence — :func:`~agentcore.conversation.compaction.declared_recovery_at`
supplies the moment upstream dated when this process is the one that took the
refusal, and stays quiet otherwise.

Deliberately silent in the cases where nothing was lost: compaction switched off
entirely (no promise was made), and every chat still inside its window (a failed
fold there is an unspent optimisation, not a missing memory — 不打扰用户).
"""

from __future__ import annotations

from dataclasses import dataclass

from agentcore.config import settings
from agentcore.conversation.compaction import declared_recovery_at
from agentcore.conversation.history import FALLBACK_CONTEXT_MAX_MESSAGES


@dataclass(frozen=True)
class ContextGap:
    """The stretch of a conversation the model can no longer see.

    ``dropped_messages`` counts stored rows, so it is exactly what the window cut —
    the same arithmetic the loader does, not an estimate. ``recovery_at`` is
    upstream's own answer to「什么时候能好」as an ISO-8601 UTC instant — never prose,
    so the client can put it in the reader's own timezone — and is ``None`` far more
    often than not; a consumer must render that absence as「稍后自动重试」rather than
    inventing a deadline.
    """

    dropped_messages: int
    recovery_at: str | None = None


def visible_window_messages(*, has_summary: bool) -> int:
    """How many un-folded messages the model still gets to read verbatim."""
    if has_summary:
        return int(settings.compaction_context_max_messages)
    return FALLBACK_CONTEXT_MAX_MESSAGES


def context_gap_for(conv: object, *, unfolded_messages: int) -> ContextGap | None:
    """The gap this conversation is currently answering with, or ``None`` if intact.

    ``unfolded_messages`` is the number of stored messages the rolling summary does
    not cover yet (everything after ``compacted_through``; the whole chat when there
    is no watermark) — see
    :meth:`~agentcore.db.repositories.MessageRepository.unfolded_counts_for_conversations`.
    """
    if not settings.compaction_enabled:
        return None
    has_summary = bool(
        getattr(conv, "compaction_summary", None) and getattr(conv, "compacted_through", None)
    )
    dropped = int(unfolded_messages) - visible_window_messages(has_summary=has_summary)
    if dropped <= 0:
        return None
    conversation_id = str(getattr(conv, "id", "") or "")
    return ContextGap(
        dropped_messages=dropped,
        recovery_at=declared_recovery_at(conversation_id) if conversation_id else None,
    )
