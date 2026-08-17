"""add platform_credentials (operator LLM key pool)

Revision ID: f1a8c3e6b9d2
Revises: e3c9a1f6b2d8
Create Date: 2026-08-18

Platform upstream keys move from a single env var to an admin-managed pool.
Each row is a bound (api_key, base_url) pair plus this Go account's
subscription-day. Ciphertext via the existing ENCRYPTION_KEY / KeyEncryptor.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f1a8c3e6b9d2"
down_revision: str | None = "e3c9a1f6b2d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "platform_credentials",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("label", sa.String(length=100), server_default=sa.text("''"), nullable=False),
        sa.Column("api_key_enc", sa.LargeBinary(), nullable=False),
        sa.Column("base_url", sa.String(length=500), nullable=False),
        sa.Column("subscription_day", sa.Integer(), nullable=False),
        sa.Column(
            "enabled",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "subscription_day >= 1 AND subscription_day <= 31",
            name="ck_platform_credentials_subscription_day",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_platform_credentials_enabled_created",
        "platform_credentials",
        ["enabled", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_platform_credentials_enabled_created",
        table_name="platform_credentials",
    )
    op.drop_table("platform_credentials")
