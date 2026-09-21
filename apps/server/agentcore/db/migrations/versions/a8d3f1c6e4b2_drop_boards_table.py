"""drop boards table (创作白板硬切)

内测无兼容层：人侧 /whiteboard、自研引擎、/v1/boards 一并卸。

Revision ID: a8d3f1c6e4b2
Revises: e4b8c2d1a7f3
Create Date: 2026-09-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "a8d3f1c6e4b2"
down_revision: str | None = "e4b8c2d1a7f3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS boards CASCADE")


def downgrade() -> None:
    raise NotImplementedError("内测硬切，不回滚 boards")
