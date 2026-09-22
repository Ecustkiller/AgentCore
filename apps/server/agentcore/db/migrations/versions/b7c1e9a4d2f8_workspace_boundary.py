"""Replace permission axes with a single workspace boundary.

Every stored recipe becomes folder. No behavior-preserving map of the old
file_write / command / host keys.

Revision ID: b7c1e9a4d2f8
Revises: a8d3f1c6e4b2
Create Date: 2026-09-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b7c1e9a4d2f8"
down_revision: str | None = "a8d3f1c6e4b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_FOLDER = "'{\"boundary\":\"folder\"}'::jsonb"


def upgrade() -> None:
    op.drop_constraint("ck_users_autonomy_policy", "users", type_="check")
    op.execute("UPDATE users SET autonomy_policy = 'folder'")
    op.alter_column(
        "users",
        "autonomy_policy",
        existing_type=sa.String(length=32),
        server_default=sa.text("'folder'"),
        existing_nullable=False,
    )
    op.create_check_constraint(
        "ck_users_autonomy_policy",
        "users",
        "autonomy_policy in ('read', 'folder', 'computer')",
    )
    op.execute(f"UPDATE conversations SET permission_axes = {_FOLDER}")
    op.alter_column(
        "conversations",
        "permission_axes",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        server_default=sa.text(_FOLDER),
        existing_nullable=False,
    )


def downgrade() -> None:
    raise NotImplementedError("workspace boundary is a hard cut; no downgrade")
