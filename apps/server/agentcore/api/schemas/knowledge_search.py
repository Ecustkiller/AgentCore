"""Knowledge-tree search DTOs (生成 / 最后修订 2026-11-04).

Owner-scoped, read-only, on-demand. This response is never injected into a
prompt on its own — the model only sees it when it calls ``search_knowledge``.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class KnowledgeSearchItem(BaseModel):
    document_id: str
    name: str
    folder_id: str | None = None
    role: str
    updated_at: datetime | None = None
    snippet: str
    match_start: int | None = None
    match_end: int | None = None
    score: float


class KnowledgeSearchResponse(BaseModel):
    query: str
    terms: list[str] = Field(default_factory=list)
    items: list[KnowledgeSearchItem] = Field(default_factory=list)
    # 候选池大小（排序、截断之前），让「为什么没找到」可诊断。
    total_candidates: int = 0
