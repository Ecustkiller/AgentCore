"""User workflows (账户级可保存的团队拆法定义)."""

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from agentcore.db.base import Base

from ._helpers import _new_uuid


class UserWorkflow(Base):
    """Account-scoped workflow definition (画布 JSON + version + 服务端来源标记)."""

    __tablename__ = "user_workflows"
    __table_args__ = (
        Index("ix_user_workflows_user_created", "user_id", "created_at"),
        # 「同一轮再点一次保存」的幂等查询（原本是拉用户全部工作流再内存扫）。
        Index(
            "ix_user_workflows_turn_source",
            "user_id",
            text("(source ->> 'conversation_id')"),
            text("(source ->> 'message_id')"),
            postgresql_where=text("source ->> 'kind' = 'turn'"),
        ),
    )

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 用户的画布内容：客户端整份覆盖，服务端只校验不重建（agentcore.workflows.definition）。
    definition: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    # 服务端权威的来源标记，创建时写一次、之后不改；客户端只读
    # （为什么不放 definition 里 → agentcore.workflows.source）。
    source: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), onupdate=datetime.now
    )
