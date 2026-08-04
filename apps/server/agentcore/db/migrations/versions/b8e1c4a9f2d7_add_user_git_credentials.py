"""add user_git_credentials (G3 account-level PAT)

Revision ID: b8e1c4a9f2d7
Revises: a7d2e9f1b4c8
Create Date: 2026-08-05 03:10:00.000000

Account-level Git PAT for cloud private-repo clone/push. Ciphertext only
(AES-256-GCM via ENCRYPTION_KEY); one row per user.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8e1c4a9f2d7"
down_revision: str | None = "a7d2e9f1b4c8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_git_credentials",
        sa.Column("user_id", sa.UUID(as_uuid=False), primary_key=True, nullable=False),
        sa.Column("token_enc", sa.LargeBinary(), nullable=False),
        sa.Column(
            "username",
            sa.String(length=200),
            server_default=sa.text("'x-access-token'"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("user_git_credentials")
