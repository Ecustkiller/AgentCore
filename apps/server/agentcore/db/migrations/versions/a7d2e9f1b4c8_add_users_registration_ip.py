"""add users.registration_ip (nullable audit column)

Revision ID: a7d2e9f1b4c8
Revises: c2e9a4f1b8d6
Create Date: 2026-08-04 06:00:00.000000

Nullable only — existing rows stay NULL; new registrations write the client IP.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7d2e9f1b4c8"
down_revision: str | None = "c2e9a4f1b8d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("registration_ip", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "registration_ip")
