"""Per-turn ``<表格>`` facts — only on a table-bound conversation."""

from __future__ import annotations

from typing import Any

from agentcore.table.constants import SELECTION_MAX
from agentcore.table.read import format_cell, row_summary
from agentcore.table.state import TableState

_MAX_SELECTED = SELECTION_MAX


def sanitize_table_selection(raw: list[str] | None) -> list[str]:
    """Keep unique non-empty row ids, capped at the prompt selection budget."""
    out: list[str] = []
    seen: set[str] = set()
    for item in raw or []:
        sid = str(item).strip()
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append(sid)
        if len(out) >= _MAX_SELECTED:
            break
    return out


async def lookup_table_id(*, conversation_id: str, user_id: str) -> str | None:
    """Bound table for this conversation, or ``None`` (ordinary chat)."""
    from agentcore.db.base import async_session_factory
    from agentcore.db.repositories.tables import TableRepository

    async with async_session_factory() as session:
        table = await TableRepository(session).get_by_conversation_id(
            conversation_id, user_id=user_id
        )
    return table.id if table else None


async def render_table_context(
    *,
    table_id: str,
    user_id: str,
    selected_ids: list[str] | None = None,
) -> str:
    """Load the live snapshot and render ``<表格>``. Empty when the table is gone."""
    from agentcore.db.base import async_session_factory
    from agentcore.db.repositories.tables import TableRepository

    selected = sanitize_table_selection(selected_ids)
    async with async_session_factory() as session:
        state = await TableRepository(session).get_state(table_id, user_id=user_id)
    if state is None:
        return ""
    by_id = {r["id"]: r for r in state.rows}
    selected_rows = [by_id[i] for i in selected if i in by_id]
    return render_table_section(state, selected_rows=selected_rows)


def render_table_section(
    state: TableState,
    *,
    selected_rows: list[dict[str, Any]] | None = None,
) -> str:
    cols = []
    for col in state.columns:
        flags = []
        ctype = col.get("type")
        if ctype in ("text", "number", "singleSelect", "multiSelect", "date", "datetime", "url"):
            flags.append("可筛")
        if ctype != "url":
            flags.append("可排")
        if ctype in ("singleSelect", "multiSelect", "checkbox", "date"):
            flags.append("可分")
        cols.append(
            f"- {col['id']} · {col.get('label')} · {ctype}"
            + (f"（{'/'.join(flags)}）" if flags else "")
        )
    views = [f"- {v['id']} · {v.get('name')} · {v.get('display_mode')}" for v in state.views]
    active = next((v for v in state.views if v["id"] == state.active_view_id), None)
    view_lines = ""
    if active:
        cfg = active.get("config") or {}
        view_lines = (
            f"当前视图 {active.get('name')}（{active.get('display_mode')}）\n"
            f"筛选 {len(cfg.get('filters') or [])} · "
            f"排序 {'开' if cfg.get('sort') else '关'} · "
            f"分组 {cfg.get('group_by') or '无'}"
        )
    selected = selected_rows or []
    sel_block = ""
    if selected:
        lines = []
        for row in selected[:_MAX_SELECTED]:
            bits = [row_summary(state, row)]
            for col in state.columns[:4]:
                if col.get("type") == "text":
                    continue
                text = format_cell(col, row["cells"].get(col["id"]))
                if text:
                    bits.append(f"{col.get('label')}={text}")
            lines.append(f"- [{row['id']}] " + " · ".join(bits))
        extra = f"\n…另 {len(selected) - _MAX_SELECTED} 行" if len(selected) > _MAX_SELECTED else ""
        sel_block = f"\n选中 {len(selected)} 行（发送时快照）：\n" + "\n".join(lines) + extra
    body = "\n".join(
        [
            f"表 {state.title} · {len(state.rows)} 行 / 上限 5000",
            "列：",
            "\n".join(cols) or "- （无）",
            "视图：",
            "\n".join(views) or "- （无）",
            view_lines,
            sel_block,
        ]
    )
    return f"<表格>\n{body.strip()}\n</表格>"
