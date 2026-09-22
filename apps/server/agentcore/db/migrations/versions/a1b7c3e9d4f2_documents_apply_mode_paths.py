"""widen documents.apply_mode to include paths

Revision ID: a1b7c3e9d4f2
Revises: f9c2e6a1b4d8
Create Date: 2026-09-23

Path-scoped user rules are a third apply mode. Unbounded patterns still count
as always at read time; the column value is ``paths``.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "a1b7c3e9d4f2"
down_revision: str | None = "f9c2e6a1b4d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_documents_apply_mode", "documents", type_="check")
    op.create_check_constraint(
        "ck_documents_apply_mode",
        "documents",
        "apply_mode in ('always', 'on_demand', 'paths')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_documents_apply_mode", "documents", type_="check")
    op.create_check_constraint(
        "ck_documents_apply_mode",
        "documents",
        "apply_mode in ('always', 'on_demand')",
    )
