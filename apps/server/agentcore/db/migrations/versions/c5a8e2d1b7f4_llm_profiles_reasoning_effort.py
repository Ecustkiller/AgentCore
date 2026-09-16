"""llm_model_profiles.reasoning_effort (vendor thinking-effort token)

Revision ID: c5a8e2d1b7f4
Revises: a2f6c8e1d4b9
Create Date: 2026-09-16

Nullable combination-level vendor token (e.g. low/high/max). NULL = that
model's vendor default. Official control values only; aliases are rejected
at the API, not stored.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c5a8e2d1b7f4"
down_revision: str | None = "a2f6c8e1d4b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "llm_model_profiles",
        sa.Column("reasoning_effort", sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("llm_model_profiles", "reasoning_effort")
