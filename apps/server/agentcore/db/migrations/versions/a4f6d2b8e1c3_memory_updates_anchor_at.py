"""memory_updates: anchor_at (thread position of the consolidated window)

Revision ID: a4f6d2b8e1c3
Revises: d5b8c2f7a1e4
Create Date: 2026-08-13

「已记下本场摘要」卡此前只能按 ``created_at`` 排在会话末尾，而 episodic 固化是 idle
debounce 触发的——卡写下来时，它总结的那批消息上面可能已经又压了几轮新对话，卡就飘到
了错的位置。``anchor_at`` = 本次固化窗口最后一条消息的 ``created_at``，前端据此把卡放
回它真正对应的位置。

刻意不用 ``message_id``：消息可删可重生成，外键一断锚点就失效，而记忆卡的生命周期本就
不跟单条消息绑（见 ``MemoryUpdateRow`` docstring）。存量行与无消息窗口的写入（semantic
扫描、quota 卡）留 NULL。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a4f6d2b8e1c3"
down_revision: str | None = "d5b8c2f7a1e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "memory_updates",
        sa.Column("anchor_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("memory_updates", "anchor_at")
