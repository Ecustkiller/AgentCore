"""tables.source_workspace_key / source_path for csv 灌数 upsert

Revision ID: f3c9a1e6b8d2
Revises: c5a8e2d1b7f4
Create Date: 2026-09-17

Same workspace path (folder or 裸聊) maps to one live table. Human-created
tables keep NULL source_path and stay outside the unique index.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f3c9a1e6b8d2"
down_revision: str | None = "c5a8e2d1b7f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "tables",
        sa.Column("source_workspace_key", sa.String(length=80), nullable=True),
    )
    op.add_column(
        "tables",
        sa.Column("source_path", sa.String(length=1000), nullable=True),
    )
    op.create_index(
        "ix_tables_source_live",
        "tables",
        ["user_id", "source_workspace_key", "source_path"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL AND source_path IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_tables_source_live", table_name="tables")
    op.drop_column("tables", "source_path")
    op.drop_column("tables", "source_workspace_key")
