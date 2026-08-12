"""add conversations.auto_desk_folder_id (裸聊自动云桌跨回合复用)

Revision ID: e8c4a1f2b9d7
Revises: d1e4a9c2f7b8
Create Date: 2026-08-12

Orthogonal to birth ``folder_id`` (归属中途不改挂 / 否决 auto-promote).
Bare-chat silent cloud desk id for reuse across turns; NULL until first provision.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e8c4a1f2b9d7"
down_revision: str | None = "d1e4a9c2f7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "auto_desk_folder_id",
            postgresql.UUID(as_uuid=False),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("conversations", "auto_desk_folder_id")
