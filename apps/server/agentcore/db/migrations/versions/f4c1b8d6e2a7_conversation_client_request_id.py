"""Idempotency key for 新建会话 (client_request_id + partial unique index).

Revision ID: f4c1b8d6e2a7
Revises: c7f2b4a9e6d3
Create Date: 2026-08-13 22:40:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f4c1b8d6e2a7"
down_revision: str | None = "c7f2b4a9e6d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Purely additive: the column is nullable with no backfill, and the index is
    # partial, so every existing row (and every client that never sends a key)
    # stays outside the constraint.
    op.add_column(
        "conversations",
        sa.Column("client_request_id", sa.String(length=100), nullable=True),
    )
    op.create_index(
        "uq_conversations_user_client_request",
        "conversations",
        ["user_id", "client_request_id"],
        unique=True,
        postgresql_where=sa.text("client_request_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_conversations_user_client_request",
        table_name="conversations",
        postgresql_where=sa.text("client_request_id IS NOT NULL"),
    )
    op.drop_column("conversations", "client_request_id")
