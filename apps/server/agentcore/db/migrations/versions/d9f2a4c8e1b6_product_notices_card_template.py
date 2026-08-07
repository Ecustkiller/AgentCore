"""product_notices card_template / summary / cover_url

Revision ID: d9f2a4c8e1b6
Revises: b8e1c4a9f2d7
Create Date: 2026-08-07 16:55:00.000000

官方号双模板：``card_template`` (service|article，默认 service)、
``summary``、``cover_url``。旧行经 server_default 落为 service。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d9f2a4c8e1b6"
down_revision: str | None = "b8e1c4a9f2d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "product_notices",
        sa.Column(
            "card_template",
            sa.String(length=32),
            server_default=sa.text("'service'"),
            nullable=False,
        ),
    )
    op.add_column(
        "product_notices",
        sa.Column("summary", sa.Text(), nullable=True),
    )
    op.add_column(
        "product_notices",
        sa.Column("cover_url", sa.String(length=2000), nullable=True),
    )
    op.create_check_constraint(
        "ck_product_notices_card_template",
        "product_notices",
        "card_template in ('service', 'article')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_product_notices_card_template", "product_notices", type_="check"
    )
    op.drop_column("product_notices", "cover_url")
    op.drop_column("product_notices", "summary")
    op.drop_column("product_notices", "card_template")
