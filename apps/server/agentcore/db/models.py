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
    local_dir: Mapped[str | None] = mapped_column(String(1000), nullable=True)
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
            "role in ('captain', 'member', 'synthesis', 'arena', 'title', 'memory')",
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
    run_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), unique=True)
    parent_run_id: Mapped[str | None] = mapped_column(
        PG_UUID(as_uuid=False), nullable=True
    )
    agent_id: Mapped[str | None] = mapped_column(PG_UUID(as_uuid=False), nullable=True)
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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
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
