"""Add cost_ledger_outbox shared DB queue (G5 mid-term).

Revision ID: e1a9c4f2b7d8
Revises: d9f2a4c8e1b6
Create Date: 2026-08-08 04:20:00.000000

Replaces process-local disk queue with a Postgres outbox drained via
``FOR UPDATE SKIP LOCKED`` so each API worker can self-drain.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e1a9c4f2b7d8"
down_revision: str | None = "d9f2a4c8e1b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "cost_ledger_outbox",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True, nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column("trace_id", sa.String(length=32), nullable=True),
        sa.Column(
            "source",
            sa.String(length=64),
            nullable=False,
            server_default=sa.text("'turn'"),
        ),
        sa.Column(
            "runs",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "calls",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "materialize_runs",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status in ('pending', 'corrupt')",
            name="ck_cost_ledger_outbox_status",
        ),
    )
    op.create_index(
        "ix_cost_ledger_outbox_pending_created",
        "cost_ledger_outbox",
        ["created_at"],
        unique=False,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_cost_ledger_outbox_pending_created",
        table_name="cost_ledger_outbox",
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.drop_table("cost_ledger_outbox")
