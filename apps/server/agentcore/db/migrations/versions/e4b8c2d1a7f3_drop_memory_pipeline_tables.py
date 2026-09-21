"""drop memory_episodes, memory_scope_states, conversations.memory_synced_at

Product AI memory (episodes / scope-state / consolidation watermark) is retired.
``memory_updates`` stays for always-quota cards.

Revision ID: e4b8c2d1a7f3
Revises: c1e7a9d4b2f6
Create Date: 2026-09-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e4b8c2d1a7f3"
down_revision: str | None = "c1e7a9d4b2f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS memory_scope_states CASCADE")
    op.execute("DROP TABLE IF EXISTS memory_episodes CASCADE")
    op.drop_column("conversations", "memory_synced_at")


def downgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("memory_synced_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "memory_episodes",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("folder_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("conversation_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False, server_default=sa.text("''")),
        sa.Column("actions_json", sa.Text(), nullable=False, server_default=sa.text("''")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("digested_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_memory_episodes_user_folder_created",
        "memory_episodes",
        ["user_id", "folder_id", "created_at"],
    )
    op.create_index(
        "ix_memory_episodes_undigested",
        "memory_episodes",
        ["user_id", "folder_id", "created_at"],
        postgresql_where=sa.text("digested_at IS NULL"),
    )
    op.create_index(
        "ix_memory_episodes_digested_at",
        "memory_episodes",
        ["digested_at"],
        postgresql_where=sa.text("digested_at IS NOT NULL"),
    )
    op.create_table(
        "memory_scope_states",
        sa.Column("id", sa.UUID(as_uuid=False), primary_key=True),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("folder_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("last_semantic_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("explore_workspace_key", sa.Text(), nullable=True),
        sa.Column("explore_fingerprint", sa.Text(), nullable=True),
        sa.Column(
            "explore_fingerprint_dirty",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_memory_scope_states_user_folder "
        "ON memory_scope_states (user_id, folder_id) NULLS NOT DISTINCT"
    )
