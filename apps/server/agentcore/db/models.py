"""SQLAlchemy ORM model definitions.

This ORM is the single source of truth for the AgentCore schema; structure is
applied via Alembic migrations (``alembic check`` must report zero drift).
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from agentcore.db.base import Base


def _new_uuid() -> str:
    return str(uuid4())


# --- Users ---
# Primary key is user_id (the users table's established convention); other
# tables reference it via a `user_id` foreign-key column (app-level integrity).


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role in ('user', 'admin')", name="ck_users_role"),
        CheckConstraint(
            "status in ('active', 'disabled')", name="ck_users_status"
        ),
    )

    user_id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
    # Login identifier (D1: username + password). Unique, required.
    username: Mapped[str] = mapped_column(String(100), unique=True)
    display_name: Mapped[str] = mapped_column(
        String(200), server_default=text("''")
    )
    # Optional, reserved for future password recovery / OAuth.
    email: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    role: Mapped[str] = mapped_column(
        String(20), default="user", server_default=text("'user'")
    )
    status: Mapped[str] = mapped_column(
        String(20), default="active", server_default=text("'active'")
    )
    # --- Per-user quota overrides (成本配额与计费.md §一, 决策④) ---
    # `is_unlimited` short-circuits all three quota checks (operator/trusted
    # accounts). The three override columns are NULL = inherit the global config
    # threshold for that dimension; a non-null value (including 0 = unlimited)
    # overrides it. Monthly cost mirrors the config unit (float USD), converted to
    # nano-USD at check time. Resolved by `QuotaLimits.for_user`.
    is_unlimited: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    quota_daily_tokens: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    quota_monthly_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    quota_daily_requests: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Per-user default 质量档 (llm/modes.py): a preset name ("economy"/"quality") or
    # a custom ModelMode id. NULL = inherit the operator default
    # (settings.default_model_mode → economy). A conversation may override it.
    default_model_mode: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )


# --- Credentials ---
# Local password auth, separated from the user profile. One row per user.


class Credentials(Base):
    __tablename__ = "credentials"

    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    # Brute-force lockout bookkeeping.
    failed_attempts: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0")
    )
    locked_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )


# --- User LLM keys (BYOK) ---
# 用户自带 DeepSeek API Key（内测期唯一计费路径，见 config.billing_mode）。一人
# 一行：endpoint / model 由服务端固定（DeepSeek-only），故此处只存「加密后的 key
# + 连通状态」，不存 endpoint / model。明文永不落库——api_key_enc 是 AES-256-GCM
# 密文（security.KeyEncryptor 加密，解析见 llm/byok.py）。


class UserLlmKey(Base):
    __tablename__ = "user_llm_keys"
    __table_args__ = (
        CheckConstraint(
            "status in ('unchecked', 'active', 'error')",
            name="ck_user_llm_keys_status",
        ),
    )

    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True)
    # AES-256-GCM ciphertext (nonce ‖ ct+tag); never the plaintext key.
    api_key_enc: Mapped[bytes] = mapped_column(LargeBinary)
    # Last connectivity-test outcome surfaced in 设置·模型配置 ('测试连接'):
    # 'unchecked' until tested, then 'active'/'error'. Reset to 'unchecked' on
    # every key change (a new key hasn't been verified yet).
    status: Mapped[str] = mapped_column(
        String(20), default="unchecked", server_default=text("'unchecked'")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )


# --- Invites ---
# Invite-code gated registration (D6).


class Invite(Base):
    __tablename__ = "invites"

    id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
    code: Mapped[str] = mapped_column(String(64), unique=True)
    created_by: Mapped[str | None] = mapped_column(
        PG_UUID(as_uuid=False), index=True, nullable=True
    )
    used_by: Mapped[str | None] = mapped_column(
        PG_UUID(as_uuid=False), index=True, nullable=True
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


# --- Conversations ---


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    agent_id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False),
        default="00000000-0000-0000-0000-000000000000",
        server_default=text("'00000000-0000-0000-0000-000000000000'"),
    )
    title: Mapped[str] = mapped_column(
        String(500), nullable=False, server_default=text("''")
    )
    # Sidebar housekeeping (对话基础功能补齐):
    # - ``pinned`` floats a conversation to the top of the sidebar / list (ordered
    #   pinned-first, then by recency).
    # - ``archived`` hides a conversation from the default sidebar / grouped list
    #   without deleting it; surfaced only in the「已归档」view, reversible.
    pinned: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    archived: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    mode: Mapped[str] = mapped_column(
        String(20), default="chat", server_default=text("'chat'")
    )
    # User folder this conversation lives in; NULL = ungrouped. App-level FK
    # (no DB constraint, per repo convention); cleared back to NULL when the
    # folder is deleted so the conversation survives as ungrouped.
    folder_id: Mapped[str | None] = mapped_column(
        PG_UUID(as_uuid=False), index=True, nullable=True
    )
    # Per-conversation 质量档 override (llm/modes.py): a preset name or custom
    # ModelMode id. NULL = inherit the user's default_model_mode → operator default.
    model_mode: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Long-term memory consolidation watermark (Agent记忆与知识系统 §1.5): the
    # created_at of the last message folded into the user's memory file by the
    # offline consolidation pass. NULL = never consolidated. The runner skips when
    # no message is newer than this, and the sweeper backstop selects conversations
    # whose latest message is newer than it (有未整合的新内容) yet has settled.
    memory_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


# --- Model modes ---
# User-defined 质量档 (custom modes, llm/modes.py D2): a named set of team-role →
# model assignments the user can pick per conversation. System presets
# (economy/quality) are code-defined, NOT rows. Soft-deleted so a conversation/user
# still referencing a removed mode resolves safely (falls back to default).


class ModelMode(Base):
    __tablename__ = "model_modes"

    id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # Team-role → model id (e.g. {"ceo": "deepseek-v4-pro"}). Roles not present
    # inherit the base profile's model. Validated against the operator ceiling on
    # write and re-clamped on resolve (llm/modes.sanitize_assignments).
    assignments: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


# --- Folders ---
# User-created conversation folders (sidebar grouping). A folder may bind a
# local directory (metadata only for now). Soft-deleted like conversations.


class Folder(Base):
    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


# --- Messages ---


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
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
    # Multi-agent execution journal for this (assistant) message: the turn's
    # ordered run/tool events ({events, finish_reason}), replayed client-side to
    # reproduce the team graph on reload. NULL for user / single-agent messages
    # (no delegation), so the column is nullable with no default.
    runs: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
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


# --- Cost Events (per-run cost ledger) ---
# Append-only ledger: one row per Run (= one Agent's participation in a turn;
# the CEO/captain root counts as a row too). This is the single source of truth
# for real money spent (不变量 #1) — ``Message.usage`` is only a display snapshot.
# The team「工资单」(GET /messages/{id}/cost) is rebuilt by querying this table by
# message_id, so it replays on reload without any extra snapshot column.


class CostEvent(Base):
    __tablename__ = "cost_events"
    __table_args__ = (
        CheckConstraint(
            "role in ('captain', 'member', 'arena', 'title', 'memory')",
            name="ck_cost_events_role",
        ),
        # Account-window aggregation (dashboard + quota): SUM over a user's recent
        # rows hits this composite index.
        Index("ix_cost_events_user_created", "user_id", "created_at"),
        # Team payroll: fetch every run row for one assistant turn.
        Index("ix_cost_events_message", "message_id"),
    )

    id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    conversation_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    # The assistant turn this run belongs to (== the persisted Message.id).
    message_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False))
    # Idempotency: a retry of the same run must not double-bill, so run_id is
    # unique and the ledger write is an upsert-by-run_id.
    #
    # NOT a UUID: a delegated worker's id is namespaced ``del_<uuid>_N`` and a
    # revision's is ``<run>_rev2`` (same posture as RunSessionRow.run_id). A native
    # uuid column here silently broke billing — record_runs writes the turn as ONE
    # multi-row INSERT, so a single non-uuid member id aborted the whole batch
    # (captain row included), and the caller swallows it to a warning. Plain
    # strings, sized like RunSessionRow.
    run_id: Mapped[str] = mapped_column(String(128), unique=True)
    parent_run_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    agent_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    role: Mapped[str] = mapped_column(String(20))
    model: Mapped[str] = mapped_column(String(50))
    # Token counts ({input, output, reasoning, cache_hit, cache_miss}).
    tokens: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    # Money is always integer nano-USD (1 USD = 1e9), never float.
    # cost = {input, cached, output, total}.
    cost: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    # Redundant scalar total so window SUMs run on an integer column (precise +
    # index-friendly), instead of digging into the JSONB each time.
    cost_total_nano: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default=text("0")
    )
    currency: Mapped[str] = mapped_column(
        String(8), default="USD", server_default=text("'USD'")
    )
    rounds: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    duration_ms: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0")
    )
    # Correlation key to the turn's runtime logs: joins a spend row to its trace
    # (per-run `run_id` already correlates to worker logs; trace_id gives the
    # turn-level join). NULL on untraced (handoff) turns. See core/log_context.py.
    trace_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


# --- Handoff Jobs (本地→云交接: 云端在快照上跑团队, 双模式工作区 P2e / e2) ---
# A dispatched cloud run seeded from a local-mode conversation's snapshot. The
# user hands a task off from their local workspace; the server restores the
# uploaded snapshot into a fresh server-side workspace, runs the Agent team there
# (autonomously — no live client, so server-sandbox isolated and un-gated), then
# snapshots the result. The team's messages / cost / run journal persist under a
# dedicated hidden ``mode="handoff"`` conversation (filtered from the sidebar), so
# the run replays by opening it. e3 then diffs result vs base back to local files.


class HandoffJob(Base):
    __tablename__ = "handoff_jobs"
    __table_args__ = (
        CheckConstraint(
            "status in ('pending', 'running', 'succeeded', 'failed')",
            name="ck_handoff_jobs_status",
        ),
        # A source conversation's job list (newest first) is the only list query;
        # the composite index also serves prefix lookups by source_conversation_id.
        Index(
            "ix_handoff_jobs_source_created",
            "source_conversation_id",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    # The local-mode conversation that dispatched this handoff: its workspace is
    # the source of truth the base snapshot was taken from. App-level FK.
    source_conversation_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False))
    # The hidden cloud conversation hosting the team run: its workspace is the
    # restored snapshot; its messages/cost/runs make the run replayable.
    job_conversation_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False))
    # Snapshot of the user's local files the cloud team runs on (the e3 diff base),
    # stored under the *source* conversation's storage key.
    base_snapshot_id: Mapped[str] = mapped_column(String(100))
    # Snapshot of the team's result, under the *job* conversation's storage key;
    # NULL until the run succeeds.
    result_snapshot_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    task: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        String(20), default="pending", server_default=text("'pending'")
    )
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


# --- Refresh Tokens ---


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    token_hash: Mapped[str] = mapped_column(String(255))
    token_family: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    rotated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


# --- IM messaging (消息页 = 找人; 消息IM.md) ---
# A separate domain from the AI conversation tables above: the 对话 page is "找
# AI" (1 user + 1 agent_id, AI-shaped Message rows with reasoning/tool_calls/runs/
# usage), while the 消息 page is "找人" (human↔human + an official account). The two
# share the *frontend* chat core, not these tables — folding人↔人 into Message would
# bloat the AI hot-path table with nullable columns and cannot hold many
# participants. Hence the dedicated chats / chat_members / chat_messages set.


class Chat(Base):
    __tablename__ = "chats"
    __table_args__ = (
        CheckConstraint(
            "type in ('dm', 'group', 'official')", name="ck_chats_type"
        ),
        # Per-user chat list ordering: chats a user belongs to (chat_members join),
        # ordered by recency. Index the sort key.
        Index("ix_chats_last_message_at", "last_message_at"),
    )

    id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
    type: Mapped[str] = mapped_column(String(20))
    # Group title; NULL for dm (client renders the peer's name) and official.
    title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    # Creator (NULL for system-owned official chats). App-level FK → users.
    created_by: Mapped[str | None] = mapped_column(
        PG_UUID(as_uuid=False), index=True, nullable=True
    )
    # Canonical "min_id:max_id" pair key for dm chats, enforcing one DM per pair
    # and giving O(1) existing-DM lookup. NULL for group / official (Postgres
    # allows many NULLs under a unique index).
    dm_key: Mapped[str | None] = mapped_column(String(73), unique=True, nullable=True)
    # When true, every user is auto-joined to this chat: new users at registration
    # and existing users via a one-time backfill (the 内测全员群 mechanism — see
    # docs/07-规划/全员反馈群落地设计.md). Generalizes to an official broadcast
    # channel later. dm/regular group chats stay false.
    auto_join: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    # Denormalized list-row preview, refreshed on each message.
    last_message_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_message_preview: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )


class ChatMember(Base):
    __tablename__ = "chat_members"
    __table_args__ = (
        CheckConstraint(
            "role in ('owner', 'admin', 'member')", name="ck_chat_members_role"
        ),
        # state=pending is the stranger "message request" gate: a DM from a
        # non-contact lands pending for the recipient until accepted.
        CheckConstraint(
            "state in ('accepted', 'pending')", name="ck_chat_members_state"
        ),
    )

    chat_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True)
    # Index for the hot "list my chats" query.
    user_id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, index=True
    )
    role: Mapped[str] = mapped_column(
        String(20), default="member", server_default=text("'member'")
    )
    state: Mapped[str] = mapped_column(
        String(20), default="accepted", server_default=text("'accepted'")
    )
    # Read cursor for unread counts (count messages created after this) and the
    # sender-side read receipt (last message id this member has seen).
    last_read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_read_message_id: Mapped[str | None] = mapped_column(
        PG_UUID(as_uuid=False), nullable=True
    )
    muted: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    # Admin-imposed 禁言 (Stage 3 审核治理): a moderator silenced this member — they
    # can still read but a send is refused (403). Distinct from `muted` (the
    # member's own notification mute) so moderation and self-service stay separate.
    muted_by_admin: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    pinned: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        CheckConstraint(
            "sender_type in ('user', 'official', 'agent')",
            name="ck_chat_messages_sender_type",
        ),
        CheckConstraint(
            "content_type in ('text', 'image', 'file', 'system_card')",
            name="ck_chat_messages_content_type",
        ),
        # Fetch a chat's messages in order (also covers chat_id prefix lookups).
        Index("ix_chat_messages_chat_created", "chat_id", "created_at"),
        # Idempotent send: a client retry with the same client_msg_id must not
        # duplicate. NULL client_msg_id (e.g. official pushes) is exempt.
        Index(
            "uq_chat_messages_client_msg",
            "chat_id",
            "sender_user_id",
            "client_msg_id",
            unique=True,
        ),
    )

    id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid
    )
    chat_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False))
    # NULL = system/official sender. App-level FK → users.
    sender_user_id: Mapped[str | None] = mapped_column(
        PG_UUID(as_uuid=False), nullable=True
    )
    sender_type: Mapped[str] = mapped_column(
        String(20), default="user", server_default=text("'user'")
    )
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_type: Mapped[str] = mapped_column(
        String(20), default="text", server_default=text("'text'")
    )
    # Reuses the Message.attachments shape (list of {name, path, ...}).
    attachments: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    # system_card deep-link payload (e.g. {kind, conversation_id}); NULL otherwise.
    payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    reply_to_message_id: Mapped[str | None] = mapped_column(
        PG_UUID(as_uuid=False), nullable=True
    )
    # Client-minted dedup key for retry-safe sends.
    client_msg_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


class UserBlock(Base):
    __tablename__ = "user_blocks"

    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True)
    blocked_user_id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )


class UserDirectorySettings(Base):
    __tablename__ = "user_directory_settings"
    __table_args__ = (
        CheckConstraint(
            "who_can_dm in ('anyone', 'contacts')",
            name="ck_user_directory_who_can_dm",
        ),
    )

    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True)
    # Open search is the product default (任意搜人); users may opt out per-axis.
    discoverable: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    who_can_dm: Mapped[str] = mapped_column(
        String(20), default="anyone", server_default=text("'anyone'")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )


# --- Recoverable worker runs (留人 跨进程落盘: 乙 热修 P3) ---
# The in-memory roster (runtime/sessions.py) keeps a finished worker alive within a
# process so the CEO can 定向唤回 (revise) it; this table is the durable backstop so
# "改下刚才那个" still hits after a restart or memory eviction. A revise loads the
# row on an in-memory miss, continues the run, and writes the extended transcript
# back. Pruned by a 7-day idle TTL sweeper (runtime/session_retention.py) on
# ``updated_at`` — independent of the message.runs graph-replay journal (different
# lifecycle, 见 docs/03-AI核心/多轮编排与队员热修.md §六 T-2 / T-5).


class RunSessionRow(Base):
    __tablename__ = "run_sessions"
    __table_args__ = (
        # TTL sweep scans by last-touch: delete rows whose updated_at < cutoff.
        Index("ix_run_sessions_updated", "updated_at"),
    )

    # The worker's namespaced run id (e.g. ``del_<uuid>_1`` / ``<run>_rev2``) — a
    # plain string, NOT a UUID, so it is the PK directly (globally unique per turn).
    run_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    # The source RunSpec (role / model tier / allowed tools / contract) as JSON, so a
    # cross-process continuation runs as the same author under the same policy.
    spec: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    # The worker's full, replayable message transcript (list of LLMMessage dicts).
    transcript: Mapped[list] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    # The latest answer, mirrored for quick display without rehydrating the spec.
    content: Mapped[str] = mapped_column(Text, default="", server_default=text("''"))
    # 改次闸 counter, persisted so the revise cap holds across processes.
    recall_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0")
    )
    # Originating turn's log trace_id, set on first persist and NOT overwritten on a
    # later revise (a revise is a new turn) — links a recoverable worker back to the
    # interaction that spawned it. NULL when untraced. See core/log_context.py.
    trace_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )


# --- Paused turns (结构化挂起 durable resume: turn 级落盘 + POST .../resume) ---
# A turn that suspended at a plan_review checkpoint, persisted so it SURVIVES a
# process restart / client disconnect — without it the whole turn (an in-memory
# asyncio task + its completed workers) is lost. One row per paused assistant
# turn, keyed by the pipeline's ``message_id``. The ``frame`` JSONB holds the full
# resumable snapshot (the delegate RunPlan with its minted ids, the completed
# workers' RunStates as seed_completed, the CEO context to rebuild the loop, and
# the journal-so-far for graph replay) — see runtime/suspension.py. The row is the
# AUTHORITATIVE pending state ONLY when no live in-process interaction exists (a
# live SSE turn settles via the interaction bridge instead); ``POST .../resume``
# claims-and-deletes it to continue on a fresh process. Deleted on resume / a
# live in-process resolve / timeout; not a graph-replay journal (different
# lifecycle from messages.runs).


class PausedTurnRow(Base):
    __tablename__ = "paused_turns"
    __table_args__ = (
        # A conversation's pending paused turns (resume lookup on reopen).
        Index("ix_paused_turns_conversation", "conversation_id"),
        # TTL sweep scans by last-touch: delete rows whose updated_at < cutoff.
        Index("ix_paused_turns_updated", "updated_at"),
    )

    # The paused turn's assistant ``message_id`` (== the pipeline's minted id), so a
    # resume reuses the same id when it finally persists the assistant message.
    message_id: Mapped[str] = mapped_column(
        PG_UUID(as_uuid=False), primary_key=True
    )
    # No column-level index=True: the conversation lookup is served by the explicit
    # ix_paused_turns_conversation in __table_args__ above; a second auto-named index
    # (ix_paused_turns_conversation_id) would drift from the migration.
    conversation_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False))
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    # The full resumable snapshot (runtime/suspension.py TurnSuspension): plan +
    # seed_completed + CEO context + journal-so-far + pending checkpoint payload.
    frame: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    # Originating turn's log trace_id, so the resumed continuation joins back to the
    # interaction that spawned it. NULL when untraced. See core/log_context.py.
    trace_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
