"""add cost_calls.platform_credential_id (platform pool member)

Revision ID: e3c9a1f6b2d8
Revises: b8d4e2a7c1f9
Create Date: 2026-08-18

Platform-paid LLM calls need to record *which* platform credential funded the
call (stable alias or hash of api_key+base_url). ``credential_source`` only
distinguishes user/platform/vendor. Column is nullable: BYOK / vendor / legacy
rows stay NULL. Logs + this column only — never SSE error context.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e3c9a1f6b2d8"
down_revision: str | None = "b8d4e2a7c1f9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "cost_calls",
        sa.Column("platform_credential_id", sa.String(length=64), nullable=True),
    )
    op.create_index(
        "ix_cost_calls_platform_credential_created",
        "cost_calls",
        ["platform_credential_id", "created_at"],
        unique=False,
        postgresql_where=sa.text("platform_credential_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_cost_calls_platform_credential_created",
        table_name="cost_calls",
    )
    op.drop_column("cost_calls", "platform_credential_id")
