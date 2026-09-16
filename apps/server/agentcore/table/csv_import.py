"""Parse a csv snapshot into typed-grid columns + rows (all ``text``)."""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from typing import Any

from agentcore.table.constants import (
    CELL_TEXT_MAX,
    COLUMN_IMPORT_MAX,
    LABEL_MAX,
    ROW_LIMIT,
    TITLE_MAX,
)
from agentcore.table.schema import new_id


@dataclass(frozen=True)
class CsvSnapshot:
    title: str
    columns: list[dict[str, Any]]
    rows: list[dict[str, Any]]
    truncated_rows: bool = False
    truncated_cols: bool = False


def is_csv_relpath(path: str) -> bool:
    name = path.replace("\\", "/").rsplit("/", 1)[-1].strip().lower()
    return name.endswith(".csv")


def title_from_csv_path(path: str) -> str:
    name = path.replace("\\", "/").rsplit("/", 1)[-1].strip()
    stem = name[:-4] if name.lower().endswith(".csv") else name
    title = stem.strip() or "未命名表格"
    return title[:TITLE_MAX]


def decode_csv_bytes(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def parse_csv_snapshot(text: str, *, title: str = "未命名表格") -> CsvSnapshot | None:
    """Return None when there is no header row."""
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    if not raw.strip():
        return None
    reader = csv.reader(io.StringIO(raw), dialect=_dialect(raw))
    try:
        header = next(reader)
    except StopIteration:
        return None
    labels = _unique_labels(header)
    if not labels:
        return None
    truncated_cols = len(labels) > COLUMN_IMPORT_MAX
    labels = labels[:COLUMN_IMPORT_MAX]
    columns = [
        {"id": new_id(), "label": label, "type": "text"} for label in labels
    ]
    rows: list[dict[str, Any]] = []
    truncated_rows = False
    for i, cells in enumerate(reader):
        if i >= ROW_LIMIT:
            truncated_rows = True
            break
        if not any(str(c).strip() for c in cells):
            continue
        mapped: dict[str, Any] = {}
        for idx, col in enumerate(columns):
            value = cells[idx] if idx < len(cells) else ""
            mapped[col["id"]] = str(value)[:CELL_TEXT_MAX]
        rows.append(
            {
                "id": new_id(),
                "position": float((len(rows) + 1) * 1000),
                "cells": mapped,
            }
        )
    return CsvSnapshot(
        title=(title or "未命名表格")[:TITLE_MAX],
        columns=columns,
        rows=rows,
        truncated_rows=truncated_rows,
        truncated_cols=truncated_cols,
    )


def remap_snapshot_columns(
    snapshot: CsvSnapshot, previous: list[dict[str, Any]]
) -> CsvSnapshot:
    """Reuse column ids when labels match so named views survive overwrite."""
    old_by_label = {
        str(c.get("label") or ""): c for c in previous if isinstance(c, dict)
    }
    columns: list[dict[str, Any]] = []
    id_map: dict[str, str] = {}
    for col in snapshot.columns:
        label = str(col.get("label") or "")
        prior = old_by_label.get(label)
        if prior and prior.get("id"):
            nid = str(prior["id"])
            columns.append({"id": nid, "label": label, "type": "text"})
            id_map[str(col["id"])] = nid
        else:
            columns.append(col)
            id_map[str(col["id"])] = str(col["id"])
    rows = []
    for row in snapshot.rows:
        cells = row.get("cells") or {}
        rows.append(
            {
                **row,
                "cells": {
                    id_map[k]: v for k, v in cells.items() if k in id_map
                },
            }
        )
    return CsvSnapshot(
        title=snapshot.title,
        columns=columns,
        rows=rows,
        truncated_rows=snapshot.truncated_rows,
        truncated_cols=snapshot.truncated_cols,
    )


def _dialect(sample: str) -> type[csv.Dialect]:
    try:
        return csv.Sniffer().sniff(sample[:4096], delimiters=",;\t")
    except csv.Error:
        return csv.excel


def _unique_labels(header: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out: list[str] = []
    for i, raw in enumerate(header):
        base = str(raw or "").strip()[:LABEL_MAX] or f"列 {i + 1}"
        n = seen.get(base, 0)
        seen[base] = n + 1
        label = base if n == 0 else f"{base} ({n + 1})"[:LABEL_MAX]
        out.append(label)
    return out
