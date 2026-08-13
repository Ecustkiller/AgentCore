"""User correction channel: documents.disputed_at (「这条不对」→ 不再注入, 留痕).

Revision ID: c9f1b6d3a2e7
Revises: b7d4f2a9c1e6
Create Date: 2026-08-13

DB-only column (照 ai_maintained): the AI owns entry bodies, so a frontmatter flag
would be wiped by the next consolidation rewrite — the very failure this channel
exists to stop. NULL = not disputed (every existing row).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c9f1b6d3a2e7"
down_revision: str | None = "b7d4f2a9c1e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column("disputed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("documents", "disputed_at")
