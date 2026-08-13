"""external grant → device binding (conversation_external_grants.device_id)

Revision ID: b6a2f4d9c3e1
Revises: f4c1b8d6e2a7
Create Date: 2026-08-13 16:05:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b6a2f4d9c3e1"
down_revision: str | None = "f4c1b8d6e2a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable with no backfill: rows registered before the binding existed keep
    # NULL, which the fulfill root rebuild reads as "no device claims this root".
    op.add_column(
        "conversation_external_grants",
        sa.Column("device_id", sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("conversation_external_grants", "device_id")
