"""widen turn_metrics.status to ok | partial | paused | error

Revision ID: b8d4e2a7c1f9
Revises: d7e4b1a9c2f6
Create Date: 2026-08-17

Round-level result is no longer binary. ``partial`` is produced this wave
(batch already declared landed product with gaps). ``paused`` is reserved in
the check so a later pause-card wave does not need a second migration; nothing
writes it yet.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "b8d4e2a7c1f9"
down_revision: str | None = "d7e4b1a9c2f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_turn_metrics_status", "turn_metrics", type_="check")
    op.create_check_constraint(
        "ck_turn_metrics_status",
        "turn_metrics",
        "status in ('ok', 'partial', 'paused', 'error')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_turn_metrics_status", "turn_metrics", type_="check")
    op.create_check_constraint(
        "ck_turn_metrics_status",
        "turn_metrics",
        "status in ('ok', 'error')",
    )
