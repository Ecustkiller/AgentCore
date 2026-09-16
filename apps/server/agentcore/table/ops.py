"""Apply a closed batch of table_ops against an in-memory :class:`TableState`."""

from __future__ import annotations

import contextlib
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from agentcore.table.constants import (
    DATA_OPS,
    OP_KINDS,
    ROW_LIMIT,
    STRUCT_OPS,
    UNDO_OPS,
    VIEW_OPS,
)
from agentcore.table.schema import (
    empty_view_config,
    new_id,
    sanitize_cells,
    sanitize_column,
    sanitize_view,
    sanitize_view_config,
)
from agentcore.table.state import TableState


@dataclass
class OpsResult:
    ok: bool
    level: str
    summary: str
    needs_confirmation: bool = False
    batch_id: str | None = None
    error: str | None = None
    state: TableState | None = None
    refused: bool = False
    # None = persist the full snapshot (undo). Otherwise only these rows + deletes.
    touched_row_ids: frozenset[str] | None = None
    deleted_row_ids: frozenset[str] = frozenset()


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _order_ops(ops: list[dict[str, Any]]) -> list[dict[str, Any]] | str:
    kinds = [str(o.get("op") or "") for o in ops]
    if any(k not in OP_KINDS for k in kinds):
        bad = next(k for k in kinds if k not in OP_KINDS)
        return f"未知操作 {bad}"
    if any(k in UNDO_OPS for k in kinds) and len(ops) != 1:
        return "undo_batch 必须单独调用"
    struct = [o for o in ops if o.get("op") in STRUCT_OPS]
    views = [o for o in ops if o.get("op") in VIEW_OPS]
    data = [o for o in ops if o.get("op") in DATA_OPS]
    undo = [o for o in ops if o.get("op") in UNDO_OPS]
    return struct + views + data + undo


def _touched_row_count(ops: list[dict[str, Any]]) -> int:
    n = 0
    for op in ops:
        kind = op.get("op")
        if kind == "upsert_rows":
            n += len(op.get("rows") or [])
        elif kind == "update_cells":
            n += 1
        elif kind == "delete_rows":
            n += len(op.get("row_ids") or op.get("rowIds") or [])
    return n


def classify_ops(
    ops: list[dict[str, Any]],
    existing_ids: set[str] | None = None,
) -> str:
    """Return L1 / L2 / L3 / refuse (>200 row updates)."""
    kinds = {str(o.get("op") or "") for o in ops}
    row_n = _touched_row_count(ops)
    known = existing_ids or set()
    if (
        row_n > 200
        and kinds & {"update_cells", "upsert_rows"}
        and "delete_rows" not in kinds
    ):
        # 单次更新 >200 行拒绝。删行走 L3（任意行数 dryRun）。
        return "refuse"
    if kinds & {"remove_column", "delete_rows"}:
        return "L3"
    if "upsert_rows" in kinds:
        inserting = False
        for op in ops:
            if op.get("op") != "upsert_rows":
                continue
            for row in op.get("rows") or []:
                if not isinstance(row, dict):
                    continue
                rid = str(row.get("id") or "").strip()
                if not rid or rid not in known:
                    inserting = True
        if inserting:
            return "L3"
    if kinds & {"add_column", "update_column"}:
        return "L2"
    if row_n >= 21:
        return "L2"
    return "L1"


def apply_ops(
    state: TableState,
    ops: list[dict[str, Any]],
    *,
    confirm: bool = False,
) -> OpsResult:
    if not ops:
        return OpsResult(ok=False, level="L1", summary="", error="ops 不能为空")
    ordered = _order_ops(ops)
    if isinstance(ordered, str):
        return OpsResult(ok=False, level="L1", summary="", error=ordered)
    existing_ids = {str(r["id"]) for r in state.rows}
    level = classify_ops(ordered, existing_ids)
    if level == "refuse":
        return OpsResult(
            ok=False,
            level="refuse",
            summary="",
            error="一次最多改 200 行，请缩小筛选后再试。",
            refused=True,
        )
    summary = _summarize(ordered)
    if level in {"L2", "L3"} and not confirm:
        return OpsResult(
            ok=True,
            level=level,
            summary=summary,
            needs_confirmation=True,
            batch_id=str(uuid4()),
            state=state,
        )
    working = _clone(state)
    inverses: list[dict[str, Any]] = []
    try:
        for op in ordered:
            inverse = _apply_one(working, op)
            if inverse:
                inverses.append(inverse)
    except OpsError as exc:
        return OpsResult(ok=False, level=level, summary=summary, error=str(exc))
    batch_id = str(uuid4())
    if inverses:
        working.undo_batch = {
            "id": batch_id,
            "inverses": list(reversed(inverses)),
            "row_stamps": {r["id"]: r.get("updated_at") for r in working.rows},
        }
    else:
        working.undo_batch = None
    touched, deleted = _writeback_from_inverses(inverses)
    if any(str(o.get("op") or "") == "undo_batch" for o in ordered):
        return OpsResult(
            ok=True,
            level=level,
            summary=summary,
            batch_id=batch_id,
            state=working,
            touched_row_ids=None,
            deleted_row_ids=frozenset(),
        )
    return OpsResult(
        ok=True,
        level=level,
        summary=summary,
        batch_id=batch_id,
        state=working,
        touched_row_ids=touched,
        deleted_row_ids=deleted,
    )


class OpsError(Exception):
    pass


def _writeback_from_inverses(
    inverses: list[dict[str, Any]],
) -> tuple[frozenset[str], frozenset[str]]:
    """Rows this batch actually changed — persist only these (格子 last-write-wins)."""
    touched: set[str] = set()
    deleted: set[str] = set()
    for inv in inverses:
        kind = inv.get("op")
        if kind == "_revert_upsert":
            touched.update(str(i) for i in (inv.get("created") or []))
            touched.update(str(p["id"]) for p in inv.get("previous") or [])
        elif kind == "update_cells":
            rid = inv.get("row_id")
            if rid:
                touched.add(str(rid))
        elif kind == "_restore_rows":
            deleted.update(str(r["id"]) for r in inv.get("rows") or [])
        elif kind == "_restore_column":
            touched.update(str(k) for k in (inv.get("cells") or {}))
    return frozenset(touched), frozenset(deleted)


def _clone(state: TableState) -> TableState:
    return replace(
        state,
        columns=[dict(c) for c in state.columns],
        rows=[
            {**r, "cells": dict(r.get("cells") or {})}
            for r in state.rows
        ],
        views=[
            {**v, "config": dict(v.get("config") or {})}
            for v in state.views
        ],
        undo_batch=dict(state.undo_batch) if state.undo_batch else None,
    )


def _apply_one(state: TableState, op: dict[str, Any]) -> dict[str, Any] | None:
    kind = op.get("op")
    if kind == "add_column":
        return _add_column(state, op)
    if kind == "update_column":
        return _update_column(state, op)
    if kind == "remove_column":
        return _remove_column(state, op)
    if kind == "upsert_rows":
        return _upsert_rows(state, op)
    if kind == "update_cells":
        return _update_cells(state, op)
    if kind == "delete_rows":
        return _delete_rows(state, op)
    if kind == "set_view":
        return _set_view(state, op)
    if kind == "save_view":
        return _save_view(state, op)
    if kind == "switch_view":
        return _switch_view(state, op)
    if kind == "delete_view":
        return _delete_view(state, op)
    if kind == "undo_batch":
        return _undo_batch(state, op)
    raise OpsError(f"未知操作 {kind}")


def _add_column(state: TableState, op: dict[str, Any]) -> dict[str, Any]:
    col = sanitize_column(
        {
            "id": op.get("id") or op.get("column_id"),
            "label": op.get("label") or "未命名",
            "type": op.get("type") or "text",
            "options": op.get("options"),
        }
    )
    if col is None:
        raise OpsError("无法添加这一列")
    if any(c["id"] == col["id"] for c in state.columns):
        raise OpsError("列 id 已存在")
    state.columns.append(col)
    state.schema_version += 1
    return {"op": "remove_column", "column_id": col["id"]}


def _update_column(state: TableState, op: dict[str, Any]) -> dict[str, Any]:
    cid = str(op.get("column_id") or op.get("id") or "")
    idx = next((i for i, c in enumerate(state.columns) if c["id"] == cid), -1)
    if idx < 0:
        raise OpsError("没有这一列")
    prev = dict(state.columns[idx])
    patch = dict(prev)
    if "label" in op and op["label"] is not None:
        patch["label"] = op["label"]
    if "type" in op and op["type"] is not None:
        patch["type"] = op["type"]
    if "options" in op:
        patch["options"] = op["options"]
    cleaned = sanitize_column(patch)
    if cleaned is None:
        raise OpsError("无法更新这一列")
    cleaned["id"] = cid
    state.columns[idx] = cleaned
    state.schema_version += 1
    return {
        "op": "update_column",
        "column_id": cid,
        "label": prev.get("label"),
        "type": prev.get("type"),
        "options": prev.get("options"),
    }


def _remove_column(state: TableState, op: dict[str, Any]) -> dict[str, Any]:
    cid = str(op.get("column_id") or op.get("id") or "")
    idx = next((i for i, c in enumerate(state.columns) if c["id"] == cid), -1)
    if idx < 0:
        raise OpsError("没有这一列")
    removed = state.columns.pop(idx)
    cell_backup = {r["id"]: r["cells"].pop(cid, None) for r in state.rows if cid in r["cells"]}
    for view in state.views:
        cfg = view.get("config") or {}
        if cfg.get("group_by") == cid:
            cfg["group_by"] = None
        sort = cfg.get("sort")
        if isinstance(sort, dict) and sort.get("column_id") == cid:
            cfg["sort"] = None
        hidden = cfg.get("hidden_column_ids") or []
        cfg["hidden_column_ids"] = [h for h in hidden if h != cid]
        widths = cfg.get("column_widths") or {}
        if isinstance(widths, dict):
            widths.pop(cid, None)
            cfg["column_widths"] = widths
        cfg["filters"] = [f for f in (cfg.get("filters") or []) if f.get("column_id") != cid]
        mode = cfg.get("mode_config") or {}
        for key in ("group_field", "date_field", "title_field"):
            if mode.get(key) == cid:
                mode.pop(key, None)
        for key in ("subtitle_fields", "card_fields"):
            if key in mode:
                mode[key] = [x for x in mode[key] if x != cid]
        cfg["mode_config"] = mode
        view["config"] = cfg
    state.schema_version += 1
    return {
        "op": "_restore_column",
        "column": removed,
        "index": idx,
        "cells": cell_backup,
    }


def _upsert_rows(state: TableState, op: dict[str, Any]) -> dict[str, Any]:
    incoming = op.get("rows") or []
    if not isinstance(incoming, list) or not incoming:
        raise OpsError("upsert_rows 需要 rows")
    by_id = {r["id"]: r for r in state.rows}
    created: list[str] = []
    previous: list[dict[str, Any]] = []
    max_pos = max((r["position"] for r in state.rows), default=0.0)
    for raw in incoming:
        if not isinstance(raw, dict):
            continue
        rid = str(raw.get("id") or "").strip()
        cells = sanitize_cells(raw.get("cells") or {}, state.columns)
        if rid and rid in by_id:
            prev = by_id[rid]
            previous.append({"id": rid, "cells": dict(prev["cells"]), "position": prev["position"]})
            prev["cells"] = {**prev["cells"], **cells}
            if raw.get("position") is not None:
                prev["position"] = float(raw["position"])
            prev["updated_at"] = _now()
        else:
            if len(state.rows) >= ROW_LIMIT:
                raise OpsError("一张表最多 5000 行")
            max_pos += 1000.0
            rid = rid or new_id()
            row = {
                "id": rid,
                "cells": cells,
                "position": float(raw["position"]) if raw.get("position") is not None else max_pos,
                "updated_at": _now(),
            }
            state.rows.append(row)
            by_id[rid] = row
            created.append(rid)
    return {"op": "_revert_upsert", "created": created, "previous": previous}


def _update_cells(state: TableState, op: dict[str, Any]) -> dict[str, Any]:
    rid = str(op.get("row_id") or op.get("id") or "")
    row = next((r for r in state.rows if r["id"] == rid), None)
    if row is None:
        raise OpsError("没有这一行")
    cells = op.get("cells")
    if not isinstance(cells, dict) or not cells:
        raise OpsError("update_cells 需要 cells")
    prev = {k: row["cells"].get(k) for k in cells}
    patched = sanitize_cells(cells, state.columns)
    row["cells"] = {**row["cells"], **patched}
    row["updated_at"] = _now()
    return {"op": "update_cells", "row_id": rid, "cells": prev}


def _delete_rows(state: TableState, op: dict[str, Any]) -> dict[str, Any]:
    ids = [str(i) for i in (op.get("row_ids") or op.get("rowIds") or [])]
    if not ids:
        raise OpsError("delete_rows 需要 row_ids")
    drop = set(ids)
    removed = [r for r in state.rows if r["id"] in drop]
    state.rows = [r for r in state.rows if r["id"] not in drop]
    return {"op": "_restore_rows", "rows": removed}


def _active_view(state: TableState) -> dict[str, Any]:
    view = next((v for v in state.views if v["id"] == state.active_view_id), None)
    if view is None and state.views:
        return state.views[0]
    if view is None:
        raise OpsError("没有视图")
    return view


def _set_view(state: TableState, op: dict[str, Any]) -> dict[str, Any]:
    view = _active_view(state)
    prev = {"op": "set_view", **_view_snapshot(view)}
    _patch_view(view, op, state.columns)
    return prev


def _save_view(state: TableState, op: dict[str, Any]) -> dict[str, Any]:
    vid = str(op.get("view_id") or op.get("id") or "").strip()
    if vid:
        view = next((v for v in state.views if v["id"] == vid), None)
        if view is None:
            raise OpsError("没有这一视图")
        prev = {"op": "_replace_view", "view": dict(view), "config": dict(view.get("config") or {})}
        _patch_view(view, op, state.columns)
        if op.get("name"):
            view["name"] = str(op["name"]).strip()[:200]
        return prev
    current = _active_view(state)
    created = sanitize_view(
        {
            "name": op.get("name") or "未命名视图",
            "display_mode": op.get("display_mode") or current["display_mode"],
            "config": current.get("config"),
            "is_default": False,
        },
        state.columns,
    )
    if created is None:
        raise OpsError("无法保存视图")
    _patch_view(created, op, state.columns)
    state.views.append(created)
    state.active_view_id = created["id"]
    return {"op": "switch_view", "view_id": current["id"], "_delete_view": created["id"]}


def _switch_view(state: TableState, op: dict[str, Any]) -> dict[str, Any]:
    vid = str(op.get("view_id") or op.get("id") or "")
    if not any(v["id"] == vid for v in state.views):
        raise OpsError("没有这一视图")
    prev = state.active_view_id
    state.active_view_id = vid
    return {"op": "switch_view", "view_id": prev}


def _delete_view(state: TableState, op: dict[str, Any]) -> dict[str, Any]:
    vid = str(op.get("view_id") or op.get("id") or "")
    if len(state.views) <= 1:
        raise OpsError("至少保留一个视图")
    idx = next((i for i, v in enumerate(state.views) if v["id"] == vid), -1)
    if idx < 0:
        raise OpsError("没有这一视图")
    removed = {
        **state.views[idx],
        "config": dict(state.views[idx].get("config") or {}),
    }
    prev_active = state.active_view_id
    state.views.pop(idx)
    if state.active_view_id == vid:
        state.active_view_id = state.views[0]["id"]
    return {
        "op": "_restore_view",
        "view": removed,
        "index": idx,
        "active_view_id": prev_active,
    }


def _undo_batch(state: TableState, op: dict[str, Any]) -> dict[str, Any] | None:
    batch_id = str(op.get("batch_id") or op.get("id") or "")
    stored = state.undo_batch
    if not stored or (batch_id and stored.get("id") != batch_id):
        raise OpsError("没有可撤销的批次")
    stamps = stored.get("row_stamps") or {}
    changed = [
        r["id"]
        for r in state.rows
        if r["id"] in stamps and r.get("updated_at") != stamps.get(r["id"])
    ]
    if changed:
        raise OpsError(f"撤销冲突：{len(changed)} 行在这批之后又被改过，整批未回滚。")
    for inverse in stored.get("inverses") or []:
        _apply_inverse(state, inverse)
    state.undo_batch = None
    return None


def _apply_inverse(state: TableState, inverse: dict[str, Any]) -> None:
    kind = inverse.get("op")
    if kind == "_restore_column":
        col = inverse["column"]
        idx = int(inverse.get("index") or 0)
        state.columns.insert(min(idx, len(state.columns)), col)
        for row in state.rows:
            if row["id"] in (inverse.get("cells") or {}):
                row["cells"][col["id"]] = inverse["cells"][row["id"]]
        state.schema_version = max(1, state.schema_version - 1)
        return
    if kind == "_revert_upsert":
        created = set(inverse.get("created") or [])
        state.rows = [r for r in state.rows if r["id"] not in created]
        prev_by = {p["id"]: p for p in inverse.get("previous") or []}
        for row in state.rows:
            if row["id"] in prev_by:
                row["cells"] = dict(prev_by[row["id"]]["cells"])
                row["position"] = prev_by[row["id"]]["position"]
        return
    if kind == "_restore_rows":
        for row in inverse.get("rows") or []:
            if not any(r["id"] == row["id"] for r in state.rows):
                state.rows.append(row)
        return
    if kind == "_replace_view":
        vid = inverse["view"]["id"]
        for i, view in enumerate(state.views):
            if view["id"] == vid:
                state.views[i] = inverse["view"]
                state.views[i]["config"] = inverse.get("config") or state.views[i]["config"]
        return
    if kind == "_restore_view":
        view = inverse["view"]
        idx = int(inverse.get("index") or 0)
        if not any(v["id"] == view["id"] for v in state.views):
            state.views.insert(min(idx, len(state.views)), view)
        if inverse.get("active_view_id"):
            state.active_view_id = inverse["active_view_id"]
        return
    if inverse.get("_delete_view"):
        drop = inverse["_delete_view"]
        if kind == "switch_view" and inverse.get("view_id"):
            with contextlib.suppress(OpsError):
                _apply_one(state, {"op": "switch_view", "view_id": inverse["view_id"]})
        state.views = [v for v in state.views if v["id"] != drop]
        if state.active_view_id == drop and state.views:
            fallback = inverse.get("view_id")
            if fallback and any(v["id"] == fallback for v in state.views):
                state.active_view_id = fallback
            else:
                state.active_view_id = state.views[0]["id"]
        return
    if kind in OP_KINDS or kind == "update_column":
        _apply_one(state, inverse)


def _patch_view(view: dict[str, Any], op: dict[str, Any], columns: list[dict[str, Any]]) -> None:
    mode = op.get("display_mode") or op.get("displayMode")
    if mode:
        allowed = ("table", "kanban", "calendar", "gallery")
        view["display_mode"] = mode if mode in allowed else view["display_mode"]
    cfg = dict(view.get("config") or empty_view_config())
    merged = {**cfg}
    if "filters" in op:
        merged["filters"] = op["filters"]
    if "sort" in op:
        merged["sort"] = op["sort"]
    if "group_by" in op or "groupBy" in op:
        merged["group_by"] = op.get("group_by", op.get("groupBy"))
    if "hidden_column_ids" in op or "hiddenColumnIds" in op:
        merged["hidden_column_ids"] = op.get("hidden_column_ids", op.get("hiddenColumnIds"))
    if "column_widths" in op or "columnWidths" in op:
        merged["column_widths"] = op.get("column_widths", op.get("columnWidths"))
    if "density" in op:
        merged["density"] = op["density"]
    if "mode_config" in op or "modeConfig" in op:
        merged["mode_config"] = op.get("mode_config", op.get("modeConfig"))
    view["config"] = sanitize_view_config(merged, columns)


def _view_snapshot(view: dict[str, Any]) -> dict[str, Any]:
    return {
        "display_mode": view.get("display_mode"),
        "filters": (view.get("config") or {}).get("filters"),
        "sort": (view.get("config") or {}).get("sort"),
        "group_by": (view.get("config") or {}).get("group_by"),
        "hidden_column_ids": (view.get("config") or {}).get("hidden_column_ids"),
        "column_widths": (view.get("config") or {}).get("column_widths"),
        "density": (view.get("config") or {}).get("density"),
        "mode_config": (view.get("config") or {}).get("mode_config"),
    }


def _summarize(ops: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for op in ops:
        kind = op.get("op")
        if kind == "add_column":
            parts.append(f"加列「{op.get('label') or ''}」")
        elif kind == "update_column":
            parts.append("改列定义")
        elif kind == "remove_column":
            parts.append("删列")
        elif kind == "upsert_rows":
            parts.append(f"写入 {len(op.get('rows') or [])} 行")
        elif kind == "update_cells":
            parts.append("改格子")
        elif kind == "delete_rows":
            parts.append(f"删 {len(op.get('row_ids') or op.get('rowIds') or [])} 行")
        elif kind == "set_view":
            parts.append("改当前视图")
        elif kind == "save_view":
            parts.append("保存视图")
        elif kind == "switch_view":
            parts.append("切换视图")
        elif kind == "delete_view":
            parts.append("删视图")
        elif kind == "undo_batch":
            parts.append("撤销上一批")
    return "；".join(parts) or "改表"
