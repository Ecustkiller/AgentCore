"""per-model reachability for the picker

Revision ID: b3e7c1a9d4f2
Revises: c6e1a4d8b2f9
Create Date: 2026-11-04

Free tiers rotate and BYOK endpoints retire model ids without notice. A profile
pinned to a retired id fails every turn with the provider's raw 404, and the
catalog cannot tell because a seeded id is listed unconditionally. This table
holds the last probe result per (user, provider, model).

No key material and no upstream body: ``detail`` is a clipped diagnosis.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b3e7c1a9d4f2"
down_revision: str | None = "c6e1a4d8b2f9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "llm_model_health",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("provider_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("model_id", sa.String(length=200), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'error'"), nullable=False
        ),
        sa.Column("detail", sa.String(length=300), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column(
            "checked_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status in ('ok', 'dead', 'throttled', 'error')",
            name="ck_llm_model_health_status",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "provider_id", "model_id", name="uq_llm_model_health_target"
        ),
    )
    op.create_index("ix_llm_model_health_user", "llm_model_health", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_llm_model_health_user", table_name="llm_model_health")
    op.drop_table("llm_model_health")
