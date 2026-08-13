"""allow account-level ledger rows (conversation_id nullable + role 'assist')

Revision ID: d5b8c2f7a1e4
Revises: c9f1b6d3a2e7
Create Date: 2026-08-13

AI 改写（文件工作台划词改写）与文档 description 自动补都真花 token，却不属于任何
会话——三张台账表的 ``conversation_id`` NOT NULL 让 call meter 只能整条丢弃这两笔
花销（宁可漏记也不编假会话 id）。拍板「放宽账本」：钱花了就该看得见。

放宽两处：``conversation_id`` 可空（账户级行，只挂 ``user_id``），role CHECK 加
``assist`` 桶（结构上既非回合角色也非会话级 title/memory chrome）。账户级行的
``message_id`` 本就为 NULL，故它不进单回合工资单、不抬「请求数」
（COUNT(DISTINCT message_id) 忽略 NULL），但会 SUM 进账户窗口与配额。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d5b8c2f7a1e4"
down_revision: str | None = "c9f1b6d3a2e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LEDGER_TABLES = ("cost_calls", "cost_events", "cost_ledger_outbox")
_ROLE_TABLES = ("cost_calls", "cost_events")
_ROLES_OLD = "('captain', 'member', 'arena', 'title', 'memory', 'vision')"
_ROLES_NEW = "('captain', 'member', 'arena', 'title', 'memory', 'vision', 'assist')"


def upgrade() -> None:
    for table in _LEDGER_TABLES:
        op.alter_column(
            table,
            "conversation_id",
            existing_type=sa.UUID(as_uuid=False),
            nullable=True,
        )
    for table in _ROLE_TABLES:
        op.drop_constraint(f"ck_{table}_role", table, type_="check")
        op.create_check_constraint(f"ck_{table}_role", table, f"role in {_ROLES_NEW}")


def downgrade() -> None:
    # NOT NULL cannot be restored while account-level rows exist; they belong to no
    # conversation and are unrepresentable under the old constraint, so a clean
    # downgrade purges them first (mirrors c1d4e7a9f3b2's message_id widen).
    for table in _LEDGER_TABLES:
        op.execute(f"DELETE FROM {table} WHERE conversation_id IS NULL")
    for table in _ROLE_TABLES:
        # Any surviving 'assist' row (conversation-scoped, shouldn't exist) maps to
        # 'title' — the closest off-turn chrome sibling. Lossy by design: downgrade
        # is rare and must never fail on live billing data.
        op.execute(f"UPDATE {table} SET role = 'title' WHERE role = 'assist'")
        op.drop_constraint(f"ck_{table}_role", table, type_="check")
        op.create_check_constraint(f"ck_{table}_role", table, f"role in {_ROLES_OLD}")
    for table in _LEDGER_TABLES:
        op.alter_column(
            table,
            "conversation_id",
            existing_type=sa.UUID(as_uuid=False),
            nullable=False,
        )
