"""行级纠错通道: documents.disputed_lines (「这条不对」落在一句上, 该句移出正文).

Revision ID: e2a7c5b9d341
Revises: a4f6d2b8e1c3
Create Date: 2026-08-13

条目级 ``disputed_at`` 停用整份内容, 但用户看到的是「记忆已更新」卡里的**一句话** ——
一刀砍掉整个条目会连带否掉仍然正确的几条。行级走另一条路: 被否的那一行从正文**移出**,
原文存进这一列。

为什么是「搬走」而不是「在正文里给那行打标记」: bullet 在正文里没有能扛住巩固整篇重写的身份,
而标记必须扛得住重写 —— 这正是 ``disputed_at`` 当初进 DB 列而非 frontmatter 的理由。搬走还顺带
让巩固读不到那句话, 不会拿它继续发挥。记录行自身带 ``id``(撤销按它寻址, 不按下标)。

DB-only 同 ``disputed_at``: AI 拥有正文, 写进 frontmatter 下一次重写就没了。
``[]`` = 没有被否掉的行(所有既有行)。元素形状见 ``db/models/documents.py`` 的 ``DisputedLine``。

**downgrade 先把内容拼回正文再删列**: 被否的那句话是**从正文移走**的, 这一列是它此刻的唯一副本
—— 直接 drop 等于让用户的原话无声消失。回填按记录里的 ``section`` 插回对应 ``## 小节``(小节没了
就在末尾补一个), 是纯文本插入、不重排正文, 故 frontmatter 与派生列都不受影响。
"""

from __future__ import annotations

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "e2a7c5b9d341"
down_revision: str | None = "a4f6d2b8e1c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")
_HEADER_RE = re.compile(r"^#{1,6}\s")


def _insert_bullet(content: str, section: str, text: str) -> str:
    """Put one rejected bullet back into ``content`` under its ``## 小节``.

    Self-contained on purpose (no import of the markdown applier): a downgrade must keep
    working against the tree it is rolling back to, and a pure insert cannot disturb the
    frontmatter block or reorder anything it did not touch.
    """
    bullet = f"- {text}"
    lines = content.split("\n")
    start = next(
        (
            i
            for i, line in enumerate(lines)
            if (m := _SECTION_RE.match(line)) and m.group(1).strip() == section
        ),
        None,
    )
    if start is None:
        body = content.rstrip("\n")
        head = f"{body}\n\n" if body else ""
        return f"{head}## {section}\n{bullet}\n" if section else f"{head}{bullet}\n"
    end = next(
        (j for j in range(start + 1, len(lines)) if _HEADER_RE.match(lines[j])),
        len(lines),
    )
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1
    lines.insert(end, bullet)
    return "\n".join(lines)


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column(
            "disputed_lines",
            JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    conn = op.get_bind()
    rows = (
        conn.execute(
            sa.text(
                "SELECT id, content, disputed_lines FROM documents "
                "WHERE jsonb_array_length(disputed_lines) > 0"
            )
        )
        .mappings()
        .all()
    )
    restored = 0
    for row in rows:
        content = row["content"] or ""
        for entry in row["disputed_lines"]:
            content = _insert_bullet(content, entry["section"], entry["text"])
            restored += 1
        conn.execute(
            sa.text("UPDATE documents SET content = :content WHERE id = CAST(:id AS uuid)"),
            {"id": row["id"], "content": content},
        )
    print(f"documents disputed_lines downgrade: restored_lines={restored}")

    op.drop_column("documents", "disputed_lines")
