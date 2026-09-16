"""Sanitize column / view / cell payloads for the creation-tool 多维表格."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from agentcore.table.constants import (
    CELL_TEXT_MAX,
    COLUMN_WIDTH_MAX,
    COLUMN_WIDTH_MIN,
    DENSITIES,
    DISPLAY_MODES,
    FIELD_TYPES,
    FILTER_OPS,
    LABEL_MAX,
    OPTION_MAX,
    OPTION_TONES,
    VIEW_NAME_MAX,
)


def new_id() -> str:
    return str(uuid4())


def empty_view_config() -> dict[str, Any]:
    return {
        "filters": [],
        "sort": None,
        "group_by": None,
        "hidden_column_ids": [],
        "column_widths": {},
        "density": "comfortable",
        "mode_config": {},
    }


def default_options(field_type: str) -> list[dict[str, Any]] | None:
    if field_type not in ("singleSelect", "multiSelect"):
        return None
    return [
        {"id": new_id(), "label": "选项 A", "tone": "gray"},
        {"id": new_id(), "label": "选项 B", "tone": "blue"},
        {"id": new_id(), "label": "选项 C", "tone": "green"},
    ]


def sanitize_option(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    label = str(raw.get("label") or "").strip()[:LABEL_MAX] or "选项"
    tone = raw.get("tone") if raw.get("tone") in OPTION_TONES else "gray"
    oid = str(raw.get("id") or "").strip() or new_id()
    return {"id": oid, "label": label, "tone": tone}


def sanitize_column(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    field_type = raw.get("type")
    if field_type not in FIELD_TYPES:
        return None
    label = str(raw.get("label") or "").strip()[:LABEL_MAX] or "未命名"
    cid = str(raw.get("id") or "").strip() or new_id()
    col: dict[str, Any] = {"id": cid, "label": label, "type": field_type}
    if field_type in ("singleSelect", "multiSelect"):
        options = [sanitize_option(o) for o in (raw.get("options") or [])]
        cleaned = [o for o in options if o is not None][:OPTION_MAX]
        col["options"] = cleaned or default_options(field_type)
    return col


def sanitize_columns(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        col = sanitize_column(item)
        if col is None or col["id"] in seen:
            continue
        seen.add(col["id"])
        out.append(col)
    return out


def sanitize_cells(
    cells: Any, columns: list[dict[str, Any]]
) -> dict[str, Any]:
    if not isinstance(cells, dict):
        return {}
    by_id = {c["id"]: c for c in columns}
    out: dict[str, Any] = {}
    for key, value in cells.items():
        col = by_id.get(str(key))
        if not col:
            continue
        coerced = coerce_cell(col, value)
        if coerced is not None or value is None:
            out[col["id"]] = coerced
        elif isinstance(value, str) and not str(value).strip():
            # coerce_cell maps blank text/url to None; still write "" so undo
            # can restore an empty seed cell and a user can clear a text cell.
            out[col["id"]] = ""
    return out


def coerce_cell(column: dict[str, Any], value: Any) -> Any:
    ctype = column["type"]
    if value is None:
        return False if ctype == "checkbox" else None
    if ctype == "checkbox":
        return bool(value)
    if ctype == "number":
        if isinstance(value, bool):
            return None
        if isinstance(value, int | float):
            return float(value)
        try:
            return float(str(value).strip())
        except ValueError:
            return None
    if ctype == "multiSelect":
        ids = value if isinstance(value, list) else [value]
        allowed = {o["id"] for o in column.get("options") or []}
        return [str(i) for i in ids if str(i) in allowed]
    if ctype in ("singleSelect",):
        text = str(value)
        allowed = {o["id"] for o in column.get("options") or []}
        return text if text in allowed else None
    text = str(value).strip()
    if not text:
        return None
    return text[:CELL_TEXT_MAX]


def sanitize_filter(raw: Any, columns: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    col_ids = {c["id"] for c in columns}
    column_id = str(raw.get("column_id") or raw.get("columnId") or "")
    if column_id not in col_ids:
        return None
    op = raw.get("op")
    if op not in FILTER_OPS:
        return None
    fid = str(raw.get("id") or "").strip() or new_id()
    return {
        "id": fid,
        "column_id": column_id,
        "op": op,
        "value": raw.get("value"),
    }


def sanitize_view_config(raw: Any, columns: list[dict[str, Any]]) -> dict[str, Any]:
    base = empty_view_config()
    if not isinstance(raw, dict):
        return base
    col_ids = {c["id"] for c in columns}
    filters = [sanitize_filter(f, columns) for f in (raw.get("filters") or [])]
    base["filters"] = [f for f in filters if f is not None]
    sort = raw.get("sort")
    if isinstance(sort, dict):
        cid = str(sort.get("column_id") or sort.get("columnId") or "")
        direction = sort.get("dir")
        if cid in col_ids and direction in ("asc", "desc"):
            base["sort"] = {"column_id": cid, "dir": direction}
    group = raw.get("group_by") or raw.get("groupBy")
    if isinstance(group, str) and group in col_ids:
        base["group_by"] = group
    hidden = raw.get("hidden_column_ids") or raw.get("hiddenColumnIds") or []
    if isinstance(hidden, list):
        base["hidden_column_ids"] = [str(i) for i in hidden if str(i) in col_ids]
    widths = raw.get("column_widths") or raw.get("columnWidths") or {}
    if isinstance(widths, dict):
        cleaned_widths: dict[str, int] = {}
        for key, val in widths.items():
            kid = str(key)
            if kid not in col_ids:
                continue
            try:
                n = int(val)
            except (TypeError, ValueError):
                continue
            cleaned_widths[kid] = max(COLUMN_WIDTH_MIN, min(COLUMN_WIDTH_MAX, n))
        base["column_widths"] = cleaned_widths
    density = raw.get("density")
    if density in DENSITIES:
        base["density"] = density
    mode = raw.get("mode_config") or raw.get("modeConfig") or {}
    if isinstance(mode, dict):
        cleaned: dict[str, Any] = {}
        for key in ("group_field", "groupField"):
            val = mode.get(key)
            if isinstance(val, str) and val in col_ids:
                cleaned["group_field"] = val
        for key in ("date_field", "dateField"):
            val = mode.get(key)
            if isinstance(val, str) and val in col_ids:
                cleaned["date_field"] = val
        for key in ("title_field", "titleField"):
            val = mode.get(key)
            if isinstance(val, str) and val in col_ids:
                cleaned["title_field"] = val
        subs = mode.get("subtitle_fields") or mode.get("subtitleFields")
        if isinstance(subs, list):
            cleaned["subtitle_fields"] = [str(i) for i in subs if str(i) in col_ids][:6]
        cards = mode.get("card_fields") or mode.get("cardFields")
        if isinstance(cards, list):
            cleaned["card_fields"] = [str(i) for i in cards if str(i) in col_ids][:8]
        base["mode_config"] = cleaned
    return base


def sanitize_view(raw: Any, columns: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    mode = raw.get("display_mode") or raw.get("displayMode") or "table"
    if mode not in DISPLAY_MODES:
        mode = "table"
    name = str(raw.get("name") or "").strip()[:VIEW_NAME_MAX] or "未命名视图"
    vid = str(raw.get("id") or "").strip() or new_id()
    return {
        "id": vid,
        "name": name,
        "display_mode": mode,
        "config": sanitize_view_config(raw.get("config"), columns),
        "is_default": bool(raw.get("is_default") or raw.get("isDefault")),
    }


def blank_seed(
    title: str = "未命名表格",
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    """Return (columns_schema, rows, default_view) for a new table."""
    title_col = {"id": new_id(), "label": "标题", "type": "text"}
    options = [
        {"id": new_id(), "label": "待办", "tone": "gray"},
        {"id": new_id(), "label": "进行中", "tone": "blue"},
        {"id": new_id(), "label": "完成", "tone": "green"},
    ]
    status = {
        "id": new_id(),
        "label": "状态",
        "type": "singleSelect",
        "options": options,
    }
    date_col = {"id": new_id(), "label": "日期", "type": "date"}
    columns = [title_col, status, date_col]
    todo = options[0]["id"]
    row = {
        "id": new_id(),
        "position": 1000.0,
        "cells": {title_col["id"]: "", status["id"]: todo, date_col["id"]: None},
    }
    view = {
        "id": new_id(),
        "name": "表格",
        "display_mode": "table",
        "config": empty_view_config(),
        "is_default": True,
    }
    return {"columns": columns}, [row], view
