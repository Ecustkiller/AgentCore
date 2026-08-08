"""Add optional vision slot columns to llm_model_profiles.

Revision ID: f4c2a8e1b9d3
Revises: e1a9c4f2b7d8
Create Date: 2026-08-08

Nullable vision_{origin,provider_id,model}; NULL = no follow_main — platform
VISION_* fallback only when billing_mode=platform (else no VisionReader).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f4c2a8e1b9d3"
down_revision: str | None = "e1a9c4f2b7d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "llm_model_profiles",
        sa.Column("vision_origin", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "llm_model_profiles",
        sa.Column(
            "vision_provider_id", postgresql.UUID(as_uuid=False), nullable=True
        ),
    )
    op.add_column(
        "llm_model_profiles",
        sa.Column("vision_model", sa.String(length=200), nullable=True),
    )
    op.create_check_constraint(
        "ck_llm_model_profiles_vision_origin",
        "llm_model_profiles",
        "vision_origin is null or vision_origin in ('platform', 'byok')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_llm_model_profiles_vision_origin",
        "llm_model_profiles",
        type_="check",
    )
    op.drop_column("llm_model_profiles", "vision_model")
    op.drop_column("llm_model_profiles", "vision_provider_id")
    op.drop_column("llm_model_profiles", "vision_origin")
