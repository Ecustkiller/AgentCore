"""less_interrupt default: host ask → session

Revision ID: c2e9a4f1b8d6
Revises: f1c9a2e8b4d7
Create Date: 2026-08-03 23:15:00.000000

Only changes the column DEFAULT for new conversation rows.
Existing permission_axes JSON is left untouched (re-pick recipe to refresh).
"""

from collections.abc import Sequence

from alembic import op

revision: str = "c2e9a4f1b8d6"
down_revision: str | None = "f1c9a2e8b4d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = (
    '\'{"file_write":"session","command":"auto",'
    '"team_kickoff":"rules","host":"session"}\'::jsonb'
)
_OLD = (
    '\'{"file_write":"session","command":"auto",'
    '"team_kickoff":"rules","host":"ask"}\'::jsonb'
)


def upgrade() -> None:
    op.execute(
        f"ALTER TABLE conversations ALTER COLUMN permission_axes SET DEFAULT {_NEW}"
    )


def downgrade() -> None:
    op.execute(
        f"ALTER TABLE conversations ALTER COLUMN permission_axes SET DEFAULT {_OLD}"
    )
