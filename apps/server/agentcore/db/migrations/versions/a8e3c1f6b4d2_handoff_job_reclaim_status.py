"""Widen handoff_jobs status for cloud-replica reclaim (applied / discarded).

Revision ID: a8e3c1f6b4d2
Revises: f4c2a8e1b9d3
Create Date: 2026-08-09

§7.6 按任务临时、结束可收: after apply or discard the job terminal status
records that the cloud host is reclaimable (soft-delete → retention sweep).
"""

from collections.abc import Sequence

from alembic import op

revision: str = "a8e3c1f6b4d2"
down_revision: str | None = "f4c2a8e1b9d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_handoff_jobs_status", "handoff_jobs", type_="check")
    op.create_check_constraint(
        "ck_handoff_jobs_status",
        "handoff_jobs",
        "status in ('pending', 'running', 'succeeded', 'failed', 'applied', 'discarded')",
    )


def downgrade() -> None:
    # Rows already in applied/discarded cannot shrink the check; refuse silently
    # by first collapsing them back to succeeded/failed is out of scope — drop
    # only when safe. Production downgrade is not expected for this additive widen.
    op.drop_constraint("ck_handoff_jobs_status", "handoff_jobs", type_="check")
    op.create_check_constraint(
        "ck_handoff_jobs_status",
        "handoff_jobs",
        "status in ('pending', 'running', 'succeeded', 'failed')",
    )
