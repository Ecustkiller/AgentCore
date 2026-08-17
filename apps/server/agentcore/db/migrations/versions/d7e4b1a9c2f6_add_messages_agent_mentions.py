"""add messages.agent_mentions column

Revision ID: d7e4b1a9c2f6
Revises: c8a1f3e6b2d9
Create Date: 2026-08-17

Conversation-page ``@`` team-role chips (soft mention). Additive JSONB, default
``[]``, so legacy rows replay as no chips. Orthogonal to ``messages.attachments``
— never a ``MessageAttachment.kind``.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d7e4b1a9c2f6"
down_revision: str | None = "c8a1f3e6b2d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column(
            "agent_mentions",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("messages", "agent_mentions")
