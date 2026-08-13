"""paused_turn_outcomes: 抢到暂停帧的那一方写下结算结论, 落败方读它

Revision ID: c7f2b4a9e6d3
Revises: e2a7c5b9d341
Create Date: 2026-08-13

``claim`` 是 ``DELETE … RETURNING``, 原子且只有一个赢家 —— 但赢家只删掉了行, 没留下
「我用什么决策结的」。落败的那一次提交只好去 ``turn_journal`` 捞最后一条 settlement,
而那条往往正是它自己几毫秒前预写的: 界面于是告诉用户「你的决策生效了」, 真正执行的却是
另一端的决策。

这张表就是赢家的结论: 决策、时刻、``checkpoint_id``、结算方, 与吃掉帧的那次 DELETE
同一个事务写下。落败方直接读它, 不再猜。

TTL 清扫写另一种终态 (``expired``), 所以「遗弃超期」与「回合已重新生成」也由这一列区分,
不再靠「assistant 行还在不在」——那个猜法与清扫「顺手删 journal」的前提本就互相矛盾。

帧 ⊕ 结论: ``paused_turns`` 有行 = 还在等人, 这里有行 = 已终结, 两者不并存 (存帧 / 回滚
claim 时清结论; 消费帧时写结论)。两处都没有 = 回合被重新生成或删除 (结论随消息级联走)。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

revision: str = "c7f2b4a9e6d3"
down_revision: str | None = "e2a7c5b9d341"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "paused_turn_outcomes",
        sa.Column("message_id", PG_UUID(as_uuid=False), primary_key=True),
        sa.Column("conversation_id", PG_UUID(as_uuid=False), nullable=False),
        sa.Column("outcome", sa.String(16), nullable=False),
        sa.Column("card_kind", sa.String(32), nullable=False, server_default=sa.text("''")),
        sa.Column("checkpoint_id", sa.String(64), nullable=False, server_default=sa.text("''")),
        sa.Column("decision", sa.String(32), nullable=False, server_default=sa.text("''")),
        sa.Column("settled_by", sa.String(64), nullable=False, server_default=sa.text("''")),
        sa.Column(
            "decided_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        # 只有 settled 行的 checkpoint_id 会上线到客户端 (``resume_settled`` 用它认卡,
        # 空串会被整帧丢弃)。expired 行不往线上送 id, 因此不受此约束 —— 一条畸形旧帧
        # 不该把 TTL 清扫永久卡死。
        sa.CheckConstraint(
            "outcome <> 'settled' OR checkpoint_id <> ''",
            name="ck_paused_turn_outcomes_settled_checkpoint",
        ),
    )
    op.create_index(
        "ix_paused_turn_outcomes_conversation",
        "paused_turn_outcomes",
        ["conversation_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_paused_turn_outcomes_conversation", table_name="paused_turn_outcomes"
    )
    op.drop_table("paused_turn_outcomes")
