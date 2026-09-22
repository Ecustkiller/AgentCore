"""drop messages.feedback column (退役回复赞踩)

Reply thumbs are removed. Keep historical ``e5b9c2f7a1d4`` (add column)
in the chain; this revision drops the column. ``downgrade`` restores the
nullable column but does not restore deleted ratings.

Revision ID: c6e1a4d8b2f9
Revises: a1b7c3e9d4f2
Create Date: 2026-09-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c6e1a4d8b2f9"
down_revision: str | None = "a1b7c3e9d4f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("messages", "feedback")


def downgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("feedback", sa.String(length=4), nullable=True),
    )
