"""add tables / table_rows / table_views (creation-tool 多维表格)

Revision ID: d4a9c2e7b1f0
Revises: c3f8a1d6e4b2
Create Date: 2026-09-13 18:30:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d4a9c2e7b1f0"
down_revision: str | None = "c3f8a1d6e4b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tables",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("conversation_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("title", sa.String(length=500), server_default=sa.text("''"), nullable=False),
        sa.Column(
            "schema",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{\"columns\": []}'::jsonb"),
            nullable=False,
        ),
        sa.Column("schema_version", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("active_view_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("undo_batch", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
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
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_tables_user_id"), "tables", ["user_id"], unique=False)
    op.create_index(
        op.f("ix_tables_conversation_id"), "tables", ["conversation_id"], unique=False
    )

    op.create_table(
        "table_rows",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("table_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column(
            "cells",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("position", sa.Float(), server_default=sa.text("1000"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_table_rows_table_id"), "table_rows", ["table_id"], unique=False)

    op.create_table(
        "table_views",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("table_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("name", sa.String(length=200), server_default=sa.text("''"), nullable=False),
        sa.Column(
            "display_mode",
            sa.String(length=32),
            server_default=sa.text("'table'"),
            nullable=False,
        ),
        sa.Column(
            "config",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_table_views_table_id"), "table_views", ["table_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_table_views_table_id"), table_name="table_views")
    op.drop_table("table_views")
    op.drop_index(op.f("ix_table_rows_table_id"), table_name="table_rows")
    op.drop_table("table_rows")
    op.drop_index(op.f("ix_tables_conversation_id"), table_name="tables")
    op.drop_index(op.f("ix_tables_user_id"), table_name="tables")
    op.drop_table("tables")
