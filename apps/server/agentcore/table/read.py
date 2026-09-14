"""Filter / sort a table snapshot for table_read."""

from __future__ import annotations

from typing import Any

from agentcore.table.constants import READ_ROW_CAP
from agentcore.table.state import TableState


def is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, list):
        return len(value) == 0
    return False


def option_label(column: dict[str, Any], option_id: Any) -> str:
    if not option_id:
        return ""
    for opt in column.get("options") or []:
        if opt.get("id") == option_id:
            return str(opt.get("label") or option_id)
    return str(option_id)


def format_cell(column: dict[str, Any], value: Any) -> str:
    if is_empty(value):
        return ""
    ctype = column.get("type")
    if ctype == "checkbox":
        return "是" if value else "否"
    if ctype == "singleSelect":
        return option_label(column, value)
    if ctype == "multiSelect" and isinstance(value, list):
        return "、".join(option_label(column, i) for i in value)
    return str(value)


def matches_filter(column: dict[str, Any], cell: Any, op: str, raw: Any) -> bool:
    if op == "empty":
        return is_empty(cell)
    if op == "not_empty":
        return not is_empty(cell)
    if op == "contains":
        return str(raw or "").lower() in str(cell or "").lower()
    if op == "any_of":
        ids = cell if isinstance(cell, list) else []
        if isinstance(raw, str):
            return raw in ids
        if isinstance(raw, list):
            return any(i in ids for i in raw)
        return False
    if op == "eq":
        if column.get("type") == "checkbox":
            return bool(cell) == bool(raw)
        if column.get("type") == "number":
            try:
                return float(cell) == float(raw)
            except (TypeError, ValueError):
                return False
        return str(cell or "") == str(raw or "")
    if op == "neq":
        return str(cell or "") != str(raw or "")
    try:
        av: Any = float(cell) if column.get("type") == "number" else str(cell or "")
        bv: Any = float(raw) if column.get("type") == "number" else str(raw or "")
    except (TypeError, ValueError):
        return False
    if op == "gt":
        return av > bv
    if op == "lt":
        return av < bv
    if op == "gte":
        return av >= bv
    if op == "lte":
        return av <= bv
    return True


def query_rows(
    state: TableState,
    *,
    filters: list[dict[str, Any]] | None = None,
    sort: dict[str, Any] | None = None,
    limit: int = READ_ROW_CAP,
) -> list[dict[str, Any]]:
    by_id = {c["id"]: c for c in state.columns}
    rows = list(state.rows)
    for clause in filters or []:
        col = by_id.get(str(clause.get("column_id") or ""))
        if not col:
            continue
        rows = [
            r
            for r in rows
            if matches_filter(
                col,
                r["cells"].get(col["id"]),
                str(clause.get("op")),
                clause.get("value"),
            )
        ]
    rows.sort(key=lambda r: r.get("position") or 0)
    if sort and sort.get("column_id") in by_id:
        col = by_id[str(sort["column_id"])]
        desc = sort.get("dir") == "desc"

        def key_fn(row: dict[str, Any]) -> tuple:
            val = row["cells"].get(col["id"])
            empty = is_empty(val)
            if col.get("type") == "number":
                try:
                    num = float(val)
                except (TypeError, ValueError):
                    num = 0.0
                return (empty, -num if desc else num)
            return (empty, str(val or ""))

        rows.sort(key=key_fn, reverse=False if col.get("type") == "number" else desc)
        if col.get("type") != "number" and desc:
            rows.sort(key=lambda r: (is_empty(r["cells"].get(col["id"])),), reverse=False)
    cap = max(1, min(int(limit or READ_ROW_CAP), READ_ROW_CAP))
    return rows[:cap]


def row_summary(state: TableState, row: dict[str, Any]) -> str:
    title = next((c for c in state.columns if c.get("type") == "text"), None)
    if title:
        text = format_cell(title, row["cells"].get(title["id"]))
        if text:
            return text
    return row["id"]
