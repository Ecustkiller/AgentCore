"""The ``documents.disputed_lines`` downgrade must not eat the user's own sentences.

A rejected line is MOVED out of the entry body, so that column is its only copy. Dropping
the column without splicing the text back would delete user content with no trace and no
message — the one thing 纠错通道 exists to avoid. Only the pure splice is covered here; the
SQL around it is one SELECT + one UPDATE.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "agentcore"
    / "db"
    / "migrations"
    / "versions"
    / "e2a7c5b9d341_documents_disputed_lines.py"
)


def _module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("disputed_lines_migration", _MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_line_goes_back_under_its_own_section():
    insert = _module()._insert_bullet
    body = (
        "---\napply: always\n---\n"
        "## 关于用户的事实\n- 用户住在深圳\n\n"
        "## 技术栈与工具\n- 用 pnpm\n"
    )

    restored = insert(body, "关于用户的事实", "用户在腾讯工作")

    assert "- 用户在腾讯工作" in restored
    # Under its own section, not appended to whatever section happens to be last.
    facts, tools = restored.split("## 技术栈与工具")
    assert "用户在腾讯工作" in facts and "用户在腾讯工作" not in tools
    # Frontmatter is the sole source for the derived columns — a splice must not touch it.
    assert restored.startswith("---\napply: always\n---\n")
    assert "- 用户住在深圳" in restored and "- 用 pnpm" in restored


def test_missing_section_is_recreated_rather_than_dropped():
    insert = _module()._insert_bullet

    restored = insert("## 技术栈与工具\n- 用 pnpm\n", "关于用户的事实", "用户在腾讯工作")

    assert "## 关于用户的事实" in restored
    assert "- 用户在腾讯工作" in restored
    assert "- 用 pnpm" in restored


def test_every_line_survives_an_empty_body():
    insert = _module()._insert_bullet

    restored = insert("", "关于用户的事实", "用户在腾讯工作")

    assert restored.strip() == "## 关于用户的事实\n- 用户在腾讯工作"
