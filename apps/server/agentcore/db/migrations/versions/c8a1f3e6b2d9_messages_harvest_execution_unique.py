"""Partial unique index: one execution_harvest user row per execution_id.

Revision ID: c8a1f3e6b2d9
Revises: b6a2f4d9c3e1
Create Date: 2026-08-17

Cross-process harvest claim. ``harvest_scheduled`` is process-local;
the synthetic user row (``usage.origin=execution_harvest``) is the durable
claim. Duplicate insert → IntegrityError → look up the claim (skip only
when the closing turn already settled or a live lease is still beating).

Does not delete or merge existing rows. If the index cannot be created
because duplicates already exist, upgrade fails so a human can inspect.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c8a1f3e6b2d9"
down_revision: str | None = "b6a2f4d9c3e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEX = "uq_messages_execution_harvest"
_WHERE = (
    "role = 'user' "
    "AND usage ->> 'origin' = 'execution_harvest' "
    "AND COALESCE(usage ->> 'execution_id', '') <> ''"
)


def upgrade() -> None:
    conn = op.get_bind()
    dups = conn.execute(
        sa.text(
            """
            SELECT usage ->> 'execution_id' AS execution_id, COUNT(*) AS n
            FROM messages
            WHERE role = 'user'
              AND usage ->> 'origin' = 'execution_harvest'
              AND COALESCE(usage ->> 'execution_id', '') <> ''
            GROUP BY 1
            HAVING COUNT(*) > 1
            """
        )
    ).fetchall()
    if dups:
        detail = ", ".join(f"{row.execution_id}×{row.n}" for row in dups[:20])
        raise RuntimeError(
            "uq_messages_execution_harvest blocked by duplicate harvest user "
            f"rows ({len(dups)} execution_id values): {detail}. "
            "Do not auto-clean; inspect and decide."
        )
    op.create_index(
        _INDEX,
        "messages",
        [sa.text("(usage ->> 'execution_id')")],
        unique=True,
        postgresql_where=sa.text(_WHERE),
    )


def downgrade() -> None:
    op.drop_index(
        _INDEX,
        table_name="messages",
        postgresql_where=sa.text(_WHERE),
    )
