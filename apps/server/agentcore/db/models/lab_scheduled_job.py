"""Opt-in lab scheduled job row (生成 / 最后修订 2026-11-04).

独立 ``lab_`` 命名空间：上游已 drop 旧的常驻任务 / 画布工作流那批表，
本表**不是**它们的复活，也不服务任何工作流画布或无人值守代跑。详见
``config/lab_schedule.py`` 的冲突说明。默认关时此表恒为空。
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from agentcore.db.base import Base

from ._helpers import _new_uuid


class LabScheduledJob(Base):
    __tablename__ = "lab_scheduled_jobs"
    __table_args__ = (
        CheckConstraint(
            "interval_seconds >= 30", name="ck_lab_scheduled_jobs_interval"
        ),
        CheckConstraint(
            "last_status is null or last_status in ('ok', 'failed', 'blocked')",
            name="ck_lab_scheduled_jobs_last_status",
        ),
        Index("ix_lab_scheduled_jobs_due", "enabled", "next_run_at"),
        Index("ix_lab_scheduled_jobs_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    user_id: Mapped[str] = mapped_column(PG_UUID(as_uuid=False), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    webhook_url: Mapped[str] = mapped_column(String(2000), nullable=False)
    # HMAC 密钥用与服务端口径一致的 KeyEncryptor 加密落盘，绝不存明文。
    secret_enc: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # 用户自定义的 JSON 对象，随通知原样带出。
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'{}'"))
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()")
    )
