"""Knowledge-tree retrieval — pure helpers shared by the HTTP endpoint and the tool.

上游《Agent记忆与知识系统》否决「向量 chunk 自动灌 prompt」（与「文件随时变」
不合；agentic 自取永远新鲜）。这里做的是**按需检索**：结果只在本次调用里可见，
不进每回合 prompt。刻意不用 embedding / 向量库：
  - 文档随时被用户改，向量索引必然滞后；
  - stock PostgreSQL 不分词中文（见 api/routes/search.py 的说明），ILIKE
    子串反而召回更稳，且零外部依赖。

本模块不 import DB：SQL 在 ``DocumentRepository.search_knowledge``，打分与片段
在这里，两边只通过 ``KnowledgeRow`` / ``KnowledgeHit`` 两个纯数据类接缝。
生成 / 最后修订 2026-11-04。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from agentcore.core.search_query import (
    earliest_term_in_text,
    parse_conversation_search_terms,
)

ILIKE_ESCAPE = "\\"
_MAX_TERMS = 8
_MAX_TERM_LEN = 100


@dataclass(frozen=True)
class KnowledgeRow:
    """One owner-scoped ``documents`` row handed over from the repository."""

    document_id: str
    name: str
    folder_id: str | None
    role: str
    updated_at: datetime | None
    content: str
    description: str


@dataclass(frozen=True)
class KnowledgeHit:
    """A rendered, relevance-ranked hit. No ORM object crosses this boundary."""

    document_id: str
    name: str
    folder_id: str | None
    role: str
    updated_at: datetime | None
    snippet: str
    match_start: int | None
    match_end: int | None
    score: float


def escape_ilike(term: str) -> str:
    """Escape LIKE wildcards so a literal ``%`` / ``_`` in the query stays literal."""
    return (
        term.replace(ILIKE_ESCAPE, ILIKE_ESCAPE * 2)
        .replace("%", ILIKE_ESCAPE + "%")
        .replace("_", ILIKE_ESCAPE + "_")
    )


def search_terms(query: str) -> list[str]:
    """AND terms (quoted phrases allowed), deduped and bounded.

    Reuses the conversation-search parser so Chinese text, quoted phrases and
    whitespace splitting behave identically everywhere.
    """
    seen: set[str] = set()
    out: list[str] = []
    for raw in parse_conversation_search_terms(query or ""):
        term = raw.strip()[:_MAX_TERM_LEN]
        if not term or term.lower() in seen:
            continue
        seen.add(term.lower())
        out.append(term)
        if len(out) >= _MAX_TERMS:
            break
    return out


def snippet_for(
    content: str,
    terms: Sequence[str],
    radius: int,
) -> tuple[str, int | None, int | None]:
    """Match-centred window plus offsets into the returned snippet (for highlighting)."""
    term = earliest_term_in_text(content, list(terms))
    if not term:
        return content[: radius * 2], None, None
    idx = content.lower().find(term.lower())
    start = max(0, idx - radius)
    end = min(len(content), idx + len(term) + radius)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(content) else ""
    snippet = f"{prefix}{content[start:end]}{suffix}"
    match_start = len(prefix) + (idx - start)
    return snippet, match_start, match_start + len(term)


def score_row(row: KnowledgeRow, terms: Sequence[str]) -> float:
    """Cheap lexical relevance: title > description > body, each capped.

    Not a vector score and not claimed to be one. SQL already enforces AND over
    all terms, so a hit with every term in the title outranks a body-only hit.
    """
    score = 0.0
    for term in terms:
        needle = term.lower()
        name_hits = min(row.name.lower().count(needle), 3)
        desc_hits = min(row.description.lower().count(needle), 3)
        content_hits = min(row.content.lower().count(needle), 5)
        # 正文词频刻意压低到 0.5：正文里出现 3 次不应盖过标题里出现 1 次，
        # 否则「部署手册」会排在「随便」后面，与人对相关度的直觉相反。
        score += 3.0 * name_hits + 2.0 * desc_hits + 0.5 * content_hits
    return score


def rank_and_render(
    rows: Sequence[KnowledgeRow],
    terms: Sequence[str],
    *,
    radius: int,
    limit: int,
) -> list[KnowledgeHit]:
    """Render snippets and rank by lexical score, keeping SQL's recency order on ties."""
    hits: list[KnowledgeHit] = []
    for row in rows:
        snippet, match_start, match_end = snippet_for(row.content, terms, radius)
        hits.append(
            KnowledgeHit(
                document_id=row.document_id,
                name=row.name,
                folder_id=row.folder_id,
                role=row.role,
                updated_at=row.updated_at,
                snippet=snippet,
                match_start=match_start,
                match_end=match_end,
                score=score_row(row, terms),
            )
        )
    # sorted() is stable: equal scores preserve the repository's updated_at DESC order.
    return sorted(hits, key=lambda hit: -hit.score)[:limit]
