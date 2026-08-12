"""Consolidation-pipeline internal state (episodic digests + per-scope sidecar).

These rows are NOT user-facing Document-tree entries. They used to live as
``情景/<id>.md`` and ``_memory_meta.json`` under ``AgentCore/记忆/``; that borrowed
the user-entry channel and broke digestion accounting / explore fingerprints.
See docs/03-AI核心/Agent记忆与知识系统.md (基座边界).
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, String, Text, text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from agentcore.db.base import Base

from ._helpers import _new_uuid


class MemoryEpisode(Base):
    """One session-summary digest for the semantic consolidation pass.

    Never injected into prompts. ``digested_at`` NULL = still undigested; set on
    successful semantic consolidation. Digested rows older than 30 days are purged
    by the consolidation sweeper.
    """

    __tablename__ = "memory_episodes"
    __table_args__ = (
        Index("ix_memory_episodes_user_folder_created", "user_id", "folder_id", "created_at"),
        Index(
            "ix_memory_episodes_undigested",
            "user_id",
            "folder_id",
            "created_at",
            postgresql_where=text("digested_at IS NULL"),
        ),
        Index(
            "ix_memory_episodes_digested_at",
            "digested_at",
            postgresql_where=text("digested_at IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_new_uuid)
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), nullable=False)
    # NULL = global scope (same semantics as documents.folder_id).
    folder_id: Mapped[str | None] = mapped_column(PG_UUID(as_uuid=False), nullable=True)
    conversation_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    # Secret-redacted action inventory JSON; empty when absent.
    actions_json: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    digested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MemoryScopeState(Base):
    """Per-(user, scope) consolidation / explore sidecar (replaces ``_memory_meta.json``).

    Digestion is tracked on :class:`MemoryEpisode.digested_at`, not an id set here.
    """

    __tablename__ = "memory_scope_states"
    __table_args__ = (
        # PG 15+: NULL folder_id (global) is one row per user, not many.
        Index(
            "uq_memory_scope_states_user_folder",
            "user_id",
            "folder_id",
            unique=True,
            postgresql_nulls_not_distinct=True,
        ),
    )

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), nullable=False)
    folder_id: Mapped[str | None] = mapped_column(PG_UUID(as_uuid=False), nullable=True)
    last_semantic_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    explore_workspace_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    explore_fingerprint: Mapped[str | None] = mapped_column(Text, nullable=True)
    explore_fingerprint_dirty: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
