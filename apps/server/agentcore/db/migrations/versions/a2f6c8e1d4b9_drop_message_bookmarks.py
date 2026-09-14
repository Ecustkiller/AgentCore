"""drop message_bookmarks table (退役消息收藏)

Message-bookmark product is removed. Keep historical ``f4a9c2e1b7d3`` (create)
in the chain; this revision drops the table. ``downgrade`` rebuilds the
final shape but does not restore deleted rows.

Revision ID: a2f6c8e1d4b9
Revises: d4a9c2e7b1f0
Create Date: 2026-09-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a2f6c8e1d4b9"
down_revision: str | None = "d4a9c2e7b1f0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index(
        "ix_message_bookmarks_conversation", table_name="message_bookmarks"
    )
    op.drop_index(
        "ix_message_bookmarks_user_created", table_name="message_bookmarks"
    )
    op.drop_table("message_bookmarks")


def downgrade() -> None:
    op.create_table(
        "message_bookmarks",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("message_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "message_id", name="uq_message_bookmarks_user_message"
        ),
    )
    op.create_index(
        "ix_message_bookmarks_user_created",
        "message_bookmarks",
        ["user_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_message_bookmarks_conversation",
        "message_bookmarks",
        ["conversation_id"],
        unique=False,
    )
