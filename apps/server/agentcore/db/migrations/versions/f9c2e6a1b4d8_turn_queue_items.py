"""durable unstarted turn queue

Revision ID: f9c2e6a1b4d8
Revises: b7c1e9a4d2f8
Create Date: 2026-09-23

Queued turns that have not started survive an engine restart. The row holds
the run payload and FIFO position. API keys are not stored.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f9c2e6a1b4d8"
down_revision: str | None = "b7c1e9a4d2f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "turn_queue_items",
        sa.Column("queue_id", sa.String(length=64), nullable=False),
        sa.Column("conversation_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), server_default=sa.text("''"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column(
            "attachments",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "agent_mentions",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "table_selection",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("requires_tools", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("x_client_platform", sa.String(length=32), nullable=True),
        sa.Column("origin_device_id", sa.String(length=64), nullable=True),
        sa.Column("interjection_id", sa.String(length=64), nullable=True),
        sa.Column("user_message_id", sa.String(length=64), nullable=True),
        sa.Column("message_id", sa.String(length=64), nullable=True),
        sa.Column("trace_id", sa.String(length=32), nullable=True),
        sa.Column("engine", sa.String(length=16), nullable=False),
        sa.Column("local_root_id", sa.String(length=200), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("queue_id"),
    )
    op.create_index(
        "ix_turn_queue_items_holder_order",
        "turn_queue_items",
        ["engine", "local_root_id", "user_id", "position"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_turn_queue_items_holder_order", table_name="turn_queue_items")
    op.drop_table("turn_queue_items")
