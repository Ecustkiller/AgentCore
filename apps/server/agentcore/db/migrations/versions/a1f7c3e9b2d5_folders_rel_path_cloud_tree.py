"""folders.rel_path — 云容器改为可见名的真目录树 (双模式工作区 §5.4)

Revision ID: a1f7c3e9b2d5
Revises: c4a7f1e8b2d6
Create Date: 2026-08-13

``rel_path`` becomes the single source of truth for where a cloud folder's
directory sits; nesting is expressed by path prefix, so no ``parent_id`` column is
added. Backfill flattens every existing folder into the tree root under a
sanitized, sibling-unique name (illegal FS characters replaced, duplicates
numbered ``(2)``, ``(3)`` …) using the very same helpers the live create path uses,
so migrated names and new names cannot drift apart.

Directories are **not** moved here — a DB rollback cannot un-``mv`` a tree. Run
``scripts/migrate_workspace_tree.py`` after this migration.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from agentcore.workspace.cloud_tree import sanitize_folder_name
from agentcore.workspace.tree_migration import plan_rel_paths

revision: str = "a1f7c3e9b2d5"
down_revision: str | None = "c4a7f1e8b2d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEX_NAME = "uq_folders_user_rel_path_live"


def upgrade() -> None:
    op.add_column("folders", sa.Column("rel_path", sa.String(length=1024), nullable=True))

    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, user_id, name FROM folders "
            "WHERE deleted_at IS NULL ORDER BY user_id, created_at, id"
        )
    ).all()
    by_user: dict[str, list[tuple[str, str]]] = {}
    for folder_id, user_id, name in rows:
        by_user.setdefault(str(user_id), []).append((str(folder_id), name or ""))
    for folders in by_user.values():
        for folder_id, rel_path in plan_rel_paths(folders).items():
            conn.execute(
                sa.text("UPDATE folders SET rel_path = :rel WHERE id = :id"),
                {"rel": rel_path, "id": folder_id},
            )

    # Soft-deleted rows get a slot too — restore reads it to remember the name and
    # parent it should come back to. No de-duplication: the unique index skips
    # deleted rows, and restore re-allocates against whoever is live at that time.
    deleted = conn.execute(
        sa.text("SELECT id, name FROM folders WHERE deleted_at IS NOT NULL")
    ).all()
    for folder_id, name in deleted:
        conn.execute(
            sa.text("UPDATE folders SET rel_path = :rel WHERE id = :id"),
            {"rel": sanitize_folder_name(name or ""), "id": str(folder_id)},
        )

    # Case-insensitive: on Windows / macOS two names differing only in case are one
    # directory, and letting both rows live would make renames overwrite each other.
    op.execute(
        sa.text(
            f"CREATE UNIQUE INDEX {_INDEX_NAME} ON folders (user_id, lower(rel_path)) "
            "WHERE deleted_at IS NULL AND rel_path IS NOT NULL"
        )
    )


def downgrade() -> None:
    op.execute(sa.text(f"DROP INDEX IF EXISTS {_INDEX_NAME}"))
    op.drop_column("folders", "rel_path")
