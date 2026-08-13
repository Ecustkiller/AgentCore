"""最近删除（项目回收站）: folders.delete_origin + conversations.archived_by_folder_delete

Revision ID: c4a7f1e8b2d6
Revises: f6b2e9c1a4d8
Create Date: 2026-08-13

Two columns, one revision — the recycle bin needs both or neither:

``folders.delete_origin`` separates a user's deliberate project delete from the
silent ``reclaim_orphan_auto_desk_folder`` sweep (both call the same
``soft_delete``); only ``'user'`` rows are listed / restorable. Existing
soft-deleted rows stay NULL on purpose: back-filling them as user deletes would
dump a pile of auto-minted bare-chat desks into a brand-new recycle bin.

``conversations.archived_by_folder_delete`` remembers which member chats the
project delete archived, so restore un-archives exactly those and leaves chats
the user archived themselves alone. Both default false/NULL, so history reads
as「不是我干的」and restores conservatively.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4a7f1e8b2d6"
down_revision: str | None = "f6b2e9c1a4d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "folders",
        sa.Column("delete_origin", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "archived_by_folder_delete",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("conversations", "archived_by_folder_delete")
    op.drop_column("folders", "delete_origin")
