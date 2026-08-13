"""move user_workflows turn source out of definition into its own column

``definition`` 是客户端整份覆盖的画布内容，服务端权威的固化来源放在里面必然被抹掉
（也能被伪造）——搬到独立列 + 幂等索引。存量把 ``definition->'source'`` 原样带过来。

Revision ID: b7d4f2a9c1e6
Revises: a1f7c3e9b2d5
Create Date: 2026-08-13 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b7d4f2a9c1e6"
down_revision: str | None = "a1f7c3e9b2d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_workflows",
        sa.Column("source", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )

    # 存量搬迁：本次之前 ``definition.source`` 是唯一的固化来源标记，补上 ``kind`` 后原样
    # 带过来（其余键一并保留，不按已知字段重建——那正是要修的形状）。
    op.execute(
        """
        UPDATE user_workflows
        SET source = jsonb_build_object('kind', 'turn') || (definition -> 'source')
        WHERE jsonb_typeof(definition) = 'object'
          AND jsonb_typeof(definition -> 'source') = 'object'
          AND definition -> 'source' ->> 'conversation_id' IS NOT NULL
          AND definition -> 'source' ->> 'message_id' IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE user_workflows
        SET definition = definition - 'source'
        WHERE jsonb_typeof(definition) = 'object'
          AND definition -> 'source' IS NOT NULL
        """
    )

    op.create_index(
        "ix_user_workflows_turn_source",
        "user_workflows",
        ["user_id", sa.text("(source ->> 'conversation_id')"), sa.text("(source ->> 'message_id')")],
        unique=False,
        postgresql_where=sa.text("source ->> 'kind' = 'turn'"),
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE user_workflows
        SET definition = jsonb_set(
            definition,
            '{source}',
            jsonb_build_object(
                'conversation_id', source ->> 'conversation_id',
                'message_id', source ->> 'message_id'
            )
        )
        WHERE jsonb_typeof(definition) = 'object'
          AND source ->> 'kind' = 'turn'
          AND source ->> 'conversation_id' IS NOT NULL
          AND source ->> 'message_id' IS NOT NULL
        """
    )
    op.drop_index("ix_user_workflows_turn_source", table_name="user_workflows")
    op.drop_column("user_workflows", "source")
