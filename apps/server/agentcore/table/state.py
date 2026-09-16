"""In-memory table snapshot used by ops / read / REST mapping."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class TableState:
    id: str
    user_id: str
    title: str
    columns: list[dict[str, Any]]
    rows: list[dict[str, Any]]
    views: list[dict[str, Any]]
    active_view_id: str
    schema_version: int
    conversation_id: str | None = None
    source_path: str | None = None
    undo_batch: dict[str, Any] | None = None
    created_at: str | None = None
    updated_at: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)
