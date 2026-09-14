"""docs body and share snapshot are markdown, not block lists

Revision ID: c3f8a1d6e4b2
Revises: b8e4f2a1c6d9
Create Date: 2026-09-13

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c3f8a1d6e4b2"
down_revision: str | None = "b8e4f2a1c6d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_MARKDOWN_EMPTY = sa.text("'{\"markdown\": \"\"}'::jsonb")
_BLOCKS_EMPTY = sa.text("'{\"schemaVersion\": 1, \"blocks\": []}'::jsonb")


def upgrade() -> None:
    op.execute(sa.text("UPDATE docs SET body = '{\"markdown\": \"\"}'::jsonb"))
    op.execute(sa.text("UPDATE doc_shares SET snapshot = '{\"markdown\": \"\"}'::jsonb"))
    op.alter_column(
        "docs",
        "body",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        existing_nullable=False,
        server_default=_MARKDOWN_EMPTY,
    )
    op.alter_column(
        "doc_shares",
        "snapshot",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        existing_nullable=False,
        server_default=_MARKDOWN_EMPTY,
    )


def downgrade() -> None:
    op.execute(
        sa.text("UPDATE docs SET body = '{\"schemaVersion\": 1, \"blocks\": []}'::jsonb")
    )
    op.execute(
        sa.text(
            "UPDATE doc_shares SET snapshot = "
            "'{\"schemaVersion\": 1, \"blocks\": []}'::jsonb"
        )
    )
    op.alter_column(
        "docs",
        "body",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        existing_nullable=False,
        server_default=_BLOCKS_EMPTY,
    )
    op.alter_column(
        "doc_shares",
        "snapshot",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        existing_nullable=False,
        server_default=_BLOCKS_EMPTY,
    )
