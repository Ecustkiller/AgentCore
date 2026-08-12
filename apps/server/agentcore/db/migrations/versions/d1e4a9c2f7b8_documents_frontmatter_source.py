"""Frontmatter as sole writable source for documents.apply_mode / description.

Revision ID: d1e4a9c2f7b8
Revises: a8e3c1f6b4d2
Create Date: 2026-08-12

- Add ``description`` derived-index column.
- Drop dead ``conditional`` from apply_mode CHECK (存量零行).
- Change apply_mode server_default to ``on_demand`` (缺席键语义).
- One-shot: write each document row's column ``apply_mode`` into body frontmatter,
  then re-derive both index columns from the body (no dual-write / compat branch).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from agentcore.documents.frontmatter import (
    FrontmatterError,
    parse_entry_frontmatter,
    set_entry_frontmatter,
    strip_entry_frontmatter,
)

revision: str = "d1e4a9c2f7b8"
down_revision: str | None = "a8e3c1f6b4d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column(
            "description",
            sa.Text(),
            server_default=sa.text("''"),
            nullable=False,
        ),
    )

    # conditional → on_demand before tightening the CHECK (存量零行, but be safe).
    op.execute(
        sa.text(
            "UPDATE documents SET apply_mode = 'on_demand' WHERE apply_mode = 'conditional'"
        )
    )

    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, kind, content, apply_mode FROM documents WHERE deleted_at IS NULL"
        )
    ).mappings().all()
    for row in rows:
        if row["kind"] != "document":
            continue
        mode = row["apply_mode"]
        if mode not in ("always", "on_demand"):
            mode = "on_demand"
        body = set_entry_frontmatter(row["content"] or "", apply=mode)
        parsed = parse_entry_frontmatter(body)
        if isinstance(parsed, FrontmatterError):
            # Should not happen after set_entry_frontmatter; index-safe fallback.
            apply_mode, description = "on_demand", ""
        else:
            apply_mode, description = parsed.apply, parsed.description
        conn.execute(
            sa.text(
                "UPDATE documents SET content = :content, apply_mode = :apply_mode, "
                "description = :description WHERE id = CAST(:id AS uuid)"
            ),
            {
                "id": row["id"],
                "content": body,
                "apply_mode": apply_mode,
                "description": description,
            },
        )

    op.drop_constraint("ck_documents_apply_mode", "documents", type_="check")
    op.create_check_constraint(
        "ck_documents_apply_mode",
        "documents",
        "apply_mode in ('always', 'on_demand')",
    )
    op.alter_column(
        "documents",
        "apply_mode",
        server_default=sa.text("'on_demand'"),
        existing_type=sa.String(length=20),
        existing_nullable=False,
    )


def downgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, kind, content, apply_mode FROM documents WHERE deleted_at IS NULL"
        )
    ).mappings().all()
    for row in rows:
        if row["kind"] != "document":
            continue
        content = row["content"] or ""
        parsed = parse_entry_frontmatter(content)
        apply_mode = row["apply_mode"]
        if not isinstance(parsed, FrontmatterError) and parsed.has_frontmatter:
            apply_mode = parsed.apply
            stripped = strip_entry_frontmatter(content)
            if stripped is not None:
                content = stripped
        conn.execute(
            sa.text(
                "UPDATE documents SET content = :content, apply_mode = :apply_mode "
                "WHERE id = CAST(:id AS uuid)"
            ),
            {"id": row["id"], "content": content, "apply_mode": apply_mode},
        )

    op.alter_column(
        "documents",
        "apply_mode",
        server_default=sa.text("'always'"),
        existing_type=sa.String(length=20),
        existing_nullable=False,
    )
    op.drop_constraint("ck_documents_apply_mode", "documents", type_="check")
    op.create_check_constraint(
        "ck_documents_apply_mode",
        "documents",
        "apply_mode in ('always', 'conditional', 'on_demand')",
    )
    op.drop_column("documents", "description")
