"""Creation-tool 多维表格 request/response schemas."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class CreateTableRequest(BaseModel):
    title: str | None = None


class UpdateTableRequest(BaseModel):
    title: str | None = None


class TableSummary(BaseModel):
    id: str
    title: str
    conversation_id: str | None = None
    schema_version: int
    row_count: int
    source_path: str | None = None
    created_at: datetime
    updated_at: datetime


class TableColumn(BaseModel):
    id: str
    label: str
    type: str
    options: list[dict[str, Any]] | None = None


class TableRowOut(BaseModel):
    id: str
    cells: dict[str, Any]
    position: float


class TableViewOut(BaseModel):
    id: str
    name: str
    display_mode: str
    config: dict[str, Any]
    is_default: bool = False


class TableDetail(BaseModel):
    id: str
    title: str
    conversation_id: str | None = None
    schema_version: int
    columns: list[TableColumn]
    rows: list[TableRowOut]
    views: list[TableViewOut]
    active_view_id: str
    source_path: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class TableOpsRequest(BaseModel):
    ops: list[dict[str, Any]] = Field(min_length=1)
    confirm: bool = False
    schema_baseline: int | None = None


class TableOpsResult(BaseModel):
    ok: bool
    level: str
    summary: str
    needs_confirmation: bool = False
    batch_id: str | None = None
    conflict: bool = False
    error: str | None = None
    table: TableDetail | None = None


class TableConversationResponse(BaseModel):
    conversation_id: str
