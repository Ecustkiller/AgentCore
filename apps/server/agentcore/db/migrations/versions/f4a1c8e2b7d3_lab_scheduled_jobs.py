"""opt-in lab: isolated scheduled outbound notifications

Revision ID: f4a1c8e2b7d3
Revises: b3e7c1a9d4f2
Create Date: 2026-11-04

⚠️ 用户 2026-11-04 明确裁定为本地实验（opt-in，默认关）。上游
``c1e7a9d4b2f6`` 已退役 clock/webhook proxy runs，架构文档把「用户工作流 /
定时代跑 / 无人值守代跑」列为否决且「不是远期」。本表用独立 ``lab_`` 命名
空间，不复活上游那批常驻任务 / 画布工作流表，也不服务工作流画布：只存
「到点给一个 URL 发 HMAC 签名通知」的最小配置。默认关时恒为空，API 404，
调度 loop 不启动。未来同步上游时整块撤回即可（drop table + 撤本迁移）。

No plaintext secrets: ``secret_enc`` is encrypted at rest with KeyEncryptor.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f4a1c8e2b7d3"
down_revision: str | None = "b3e7c1a9d4f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "lab_scheduled_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("interval_seconds", sa.Integer(), nullable=False),
        sa.Column("webhook_url", sa.String(length=2000), nullable=False),
        sa.Column("secret_enc", sa.LargeBinary(), nullable=False),
        sa.Column(
            "payload_json", sa.Text(), server_default=sa.text("'{}'"), nullable=False
        ),
        sa.Column(
            "enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_status", sa.String(length=20), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "interval_seconds >= 30", name="ck_lab_scheduled_jobs_interval"
        ),
        sa.CheckConstraint(
            "last_status is null or last_status in ('ok', 'failed', 'blocked')",
            name="ck_lab_scheduled_jobs_last_status",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_lab_scheduled_jobs"),
    )
    op.create_index(
        "ix_lab_scheduled_jobs_due", "lab_scheduled_jobs", ["enabled", "next_run_at"]
    )
    op.create_index("ix_lab_scheduled_jobs_user", "lab_scheduled_jobs", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_lab_scheduled_jobs_user", table_name="lab_scheduled_jobs")
    op.drop_index("ix_lab_scheduled_jobs_due", table_name="lab_scheduled_jobs")
    op.drop_table("lab_scheduled_jobs")
