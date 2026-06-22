"""Conversation domain models: Conversation, Folder, Message, ConversationShare."""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from agentcore.db.base import Base

from ._helpers import _new_uuid

# --- Conversations ---


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    agent_id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False),
        default="00000000-0000-0000-0000-000000000000",
        server_default=text("'00000000-0000-0000-0000-000000000000'"),
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False, server_default=text("''"))
    # Sidebar housekeeping (对话基础功能补齐):
    # - ``pinned`` floats a conversation to the top of the sidebar / list (ordered
    #   pinned-first, then by recency).
    # - ``archived`` hides a conversation from the default sidebar / grouped list
    #   without deleting it; surfaced only in the「已归档」view, reversible.
    pinned: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    archived: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    mode: Mapped[str] = mapped_column(String(20), default="chat", server_default=text("'chat'"))
    # User folder this conversation lives in; NULL = ungrouped. App-level FK
    # (no DB constraint, per repo convention); cleared back to NULL when the
    # folder is deleted so the conversation survives as ungrouped.
    folder_id: Mapped[str | None] = mapped_column(PG_UUID(as_uuid=False), index=True, nullable=True)
    # Per-conversation 质量档 override (llm/modes.py): a preset name or custom
    # ModelMode id. NULL = inherit the user's default_model_mode → operator default.
    model_mode: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Desktop's intended local container root (工作区对称化 D1a), captured at creation
    # from the desktop client (NULL = cloud intent: web / mobile /「云端临时对话」). When
    # a 裸聊 first produces a file — by an Agent turn OR a panel write — it is lazily
    # promoted into a *local* workspace under this container root instead of a cloud
    # folder, so BOTH promotion paths agree on locality regardless of which writes first
    # (previously whichever wrote first — turn vs panel — decided cloud-vs-local). Read
    # by every promotion path; ignored once the conversation already has a folder.
    local_container_root_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Long-term memory consolidation watermark (Agent记忆与知识系统 §1.5): the
    # created_at of the last message folded into the user's memory file by the
    # offline consolidation pass. NULL = never consolidated. The runner skips when
    # no message is newer than this, and the sweeper backstop selects conversations
    # whose latest message is newer than it (有未整合的新内容) yet has settled.
    memory_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Long-conversation compaction (执行引擎架构设计 §十三 长对话压缩 / conversation/
    # compaction.py). A rolling summary folds turns OLDER than the recency window into
    # 已确立事实 / 决策 / 未决问题 / 文件路径, so a long chat feeds [summary] + recent
    # turns instead of the whole transcript — fighting context rot + cache-lapse cost,
    # not window overflow (DeepSeek's 1M does not overflow). Three columns, all NULL =
    # never compacted (the loader falls back to the plain recent window):
    #   compaction_summary       — the current rolling summary text
    #   compacted_through        — watermark: created_at of the last message folded in
    #   compaction_input_tokens  — the turn input tokens measured at the last (re)compaction
    # Computed OFF the turn by the token-triggered background pass, then REUSED across
    # turns (compute once, never per-turn) so the DeepSeek exact-prefix cache holds —
    # recomputing the prefix every turn would bust it (see runtime/prompt.py).
    compaction_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    compacted_through: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    compaction_input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


# --- Folders ---
# User-created conversation folders (sidebar grouping). A folder may bind a
# local directory (metadata only for now). Soft-deleted like conversations.


class Folder(Base):
    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Optional bound local directory; stored as opaque metadata (no FS coupling).
    # This is the human-readable *path label* the user sees, distinct from the
    # machine-addressable binding below.
    local_dir: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    # Local-mode binding (双模式工作区 §七): the desktop FS root id this folder (=
    # 工作区) is bound to. NULL = cloud. Its conversations all run in local mode
    # against this root. Opaque desktop handle minted by the desktop (fs-service
    # `randomUUID`), so a plain string, not PG_UUID (not a server-owned id).
    local_root_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Sub-path *within* ``local_root_id`` this workspace lives at (工作区对称化 D1a).
    # NULL/"" = the folder is the root itself (an explicitly-added local project).
    # A non-empty segment marks a per-conversation workspace lazily promoted under a
    # shared container root (~/Documents/AgentCore/<title>/): same container root,
    # distinct subpath, so each file-producing desktop chat reads as its own card —
    # symmetric with cloud bare-chat promotion. Server-generated (not user input),
    # a single FS-safe path segment; the desktop joins ``root + subpath``.
    local_subpath: Mapped[str | None] = mapped_column(String(400), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


# --- Messages ---


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    conversation_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    reasoning_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    tool_calls: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    usage: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # User-referenced attachments metadata (list of {name, path, truncated}).
    attachments: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    # Web sources consulted for this (assistant) message: list of
    # {url, title, snippet, site}. Rendered as source cards; UI-only metadata.
    citations: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    # The turn's replay payload (team graph / single-agent 思考+工具 timeline) is NO
    # LONGER stored here — it is the唯一事实源 ``turn_journal`` table (§18.3 Turn
    # Journal), keyed by this message id, and PROJECTED into MessageDetail.runs on
    # read. See agentcore.runtime.journal.
    finish_reason: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # Correlation key to the turn's runtime logs (logs/dev.jsonl): the assistant
    # message joins to its interaction's full log trace (chat.turn_*/llm/tool/...)
    # — message rows otherwise carry only UUIDs, so trace_id is what makes a turn
    # greppable from a persisted reply. NULL on user / untraced (handoff) messages.
    # 32-hex, minted by core/log_context.new_trace_id (not a DB-format uuid).
    trace_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


# --- Conversation shares (公开只读分享链接: 对标 ChatGPT 分享) ---
# A public, read-only link to a snapshot of a conversation. 分享 is an explicit,
# opt-in action (隐私承诺: 分享 = 显式操作、操作前明示), so a row only exists once
# the owner创建分享. The transcript is FROZEN into ``snapshot`` at share time
# (所见即所享): the public page renders that copy, so later edits/deletes to the
# live messages never leak into a shared link, and no future turns are exposed.
# Content-only by design — the snapshot holds just role + content + timestamp, never
# reasoning / cost / team graph / files (those are private). The row id doubles as
# the unguessable URL token (uuid4 = 122 bits). Revoked (not hard-deleted) so a
# killed link 404s immediately while the audit trail survives; cascade-revoked when
# the conversation is deleted or the account is注销 (ownership lifecycle).


class ConversationShare(Base):
    __tablename__ = "conversation_shares"
    __table_args__ = (
        # The owner's "manage shares for this conversation" list.
        Index("ix_conversation_shares_conversation", "conversation_id"),
        # Account-注销 cascade revokes every share a user created.
        Index("ix_conversation_shares_user", "user_id"),
    )

    # PK doubles as the public share token (uuid4, unguessable) — the public URL is
    # ``/shared/<id>``. No separate token column needed (consistent with repo PKs).
    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    # The shared conversation + its owner (app-level FKs, per repo convention).
    conversation_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False))
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False))
    # Conversation title captured at share time (the public page heading), frozen
    # alongside the transcript so a later rename doesn't change a live link.
    title: Mapped[str] = mapped_column(String(500), server_default=text("''"))
    # The frozen, content-only transcript: a list of {role, content, created_at(iso)}
    # for the user/assistant turns at share time. Immutable — the public render reads
    # this, never the live messages (所见即所享 + no future-turn leak).
    snapshot: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    # Set when the owner revokes the link (or a cascade does); a revoked share 404s
    # on the public page. Soft (not a row delete) so revocation is observable and the
    # link can never silently reactivate.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
