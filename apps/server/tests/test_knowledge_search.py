"""知识树按需检索：纯函数 / opt-in 工具面 / 工具渲染（生成 / 最后修订 2026-11-04）。

对应《Agent记忆与知识系统》「否决」表：不做向量 chunk 自动灌 prompt，只做
agentic 自取。这里同时守住两条：默认工具面不变，以及检索结果只在一次调用里可见。
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from agentcore.config import settings
from agentcore.documents.knowledge_search import (
    KnowledgeRow,
    escape_ilike,
    rank_and_render,
    score_row,
    search_terms,
    snippet_for,
)

_NOW = datetime(2026, 11, 4, 8, 0, tzinfo=UTC)


def _row(
    name: str,
    content: str,
    *,
    description: str = "",
    role: str = "general",
    doc_id: str = "d1",
) -> KnowledgeRow:
    return KnowledgeRow(
        document_id=doc_id,
        name=name,
        folder_id=None,
        role=role,
        updated_at=_NOW,
        content=content,
        description=description,
    )


class TestSearchTerms:
    def test_and_terms_with_quoted_phrase_and_dedup(self):
        assert search_terms('部署 "灰度发布" 部署') == ["部署", "灰度发布"]

    def test_empty_query_has_no_terms(self):
        assert search_terms("   ") == []
        assert search_terms('""') == []
        assert search_terms("") == []

    def test_terms_are_bounded(self):
        terms = search_terms(" ".join(f"k{i}" for i in range(20)))
        assert len(terms) == 8


class TestEscapeIlike:
    def test_wildcards_and_backslash_stay_literal(self):
        assert escape_ilike("100%_x\\y") == "100\\%\\_x\\\\y"


class TestSnippet:
    def test_match_centred_window_with_offsets(self):
        text = "前" * 100 + "部署灰度发布" + "后" * 100
        snippet, start, end = snippet_for(text, ["灰度发布"], radius=10)
        assert "灰度发布" in snippet
        assert snippet[start:end] == "灰度发布"
        assert snippet.startswith("…") and snippet.endswith("…")

    def test_no_term_falls_back_to_prefix_without_offsets(self):
        snippet, start, end = snippet_for("abcdef", ["zzz"], radius=2)
        assert snippet == "abcd"
        assert start is None and end is None


class TestScoreAndRank:
    def test_title_hit_outranks_body_only_hit(self):
        title_hit = _row("部署手册", "无关正文", doc_id="title")
        body_hit = _row("随便", "部署部署部署", doc_id="body")
        assert score_row(title_hit, ["部署"]) > score_row(body_hit, ["部署"])

    def test_equal_scores_keep_repository_recency_order(self):
        rows = [
            _row("a", "部署", doc_id="first"),
            _row("b", "部署", doc_id="second"),
        ]
        hits = rank_and_render(rows, ["部署"], radius=20, limit=2)
        assert [h.document_id for h in hits] == ["first", "second"]

    def test_limit_and_snippet_are_rendered(self):
        rows = [_row(f"n{i}", "部署说明", doc_id=f"d{i}") for i in range(5)]
        hits = rank_and_render(rows, ["部署"], radius=20, limit=2)
        assert len(hits) == 2
        assert all("部署" in h.snippet for h in hits)


class TestOptInRoster:
    """默认关：registry / 能力目录 / 开场表读到的声明集必须一致。"""

    def test_tool_absent_by_default(self, monkeypatch):
        import agentcore.tools.registration as reg

        monkeypatch.setattr(settings, "knowledge_search_enabled", False)
        reg._DECLARED_TOOLS = None
        try:
            assert "search_knowledge" not in reg.declared_tool_names()
        finally:
            reg._DECLARED_TOOLS = None

    def test_tool_present_when_enabled(self, monkeypatch):
        import agentcore.tools.registration as reg

        monkeypatch.setattr(settings, "knowledge_search_enabled", True)
        reg._DECLARED_TOOLS = None
        try:
            assert "search_knowledge" in reg.declared_tool_names()
        finally:
            reg._DECLARED_TOOLS = None


class _FakeSessionCtx:
    async def __aenter__(self) -> object:
        return object()

    async def __aexit__(self, *args: object) -> bool:
        return False


class TestTool:
    async def test_empty_query_short_circuits_before_db(self):
        from agentcore.tools.builtin.knowledge_search import KnowledgeSearchTool

        res = await KnowledgeSearchTool().execute(
            {"query": "   "}, SimpleNamespace(user_id="u1")
        )
        assert res.success is True
        assert "请提供关键词" in res.output
        assert res.display["result_count"] == 0

    async def test_renders_hits_without_claiming_auto_injection(self, monkeypatch):
        from agentcore.tools.builtin import knowledge_search as mod

        rows = [_row("部署手册.md", "先灰度发布，再全量部署", doc_id="doc-1")]

        class _FakeRepo:
            def __init__(self, session: object) -> None:
                del session

            async def search_knowledge(
                self, user_id: str, query: str, *, limit: int
            ) -> list[KnowledgeRow]:
                assert user_id == "u1"
                assert query == "部署"
                return rows

        monkeypatch.setattr(mod, "async_session_factory", lambda: _FakeSessionCtx())
        monkeypatch.setattr(mod, "DocumentRepository", _FakeRepo)
        res = await mod.KnowledgeSearchTool().execute(
            {"query": "部署"}, SimpleNamespace(user_id="u1")
        )
        assert res.success is True
        assert "部署手册.md" in res.output
        assert "doc-1" in res.output
        assert "灰度发布" in res.output
        assert "不会自动进入后续对话" in res.output
        assert res.display["result_count"] == 1

    async def test_no_hits_uses_soft_miss(self, monkeypatch):
        from agentcore.tools.builtin import knowledge_search as mod

        class _FakeRepo:
            def __init__(self, session: object) -> None:
                del session

            async def search_knowledge(
                self, user_id: str, query: str, *, limit: int
            ) -> list[KnowledgeRow]:
                return []

        monkeypatch.setattr(mod, "async_session_factory", lambda: _FakeSessionCtx())
        monkeypatch.setattr(mod, "DocumentRepository", _FakeRepo)
        res = await mod.KnowledgeSearchTool().execute(
            {"query": "部署"}, SimpleNamespace(user_id="u1")
        )
        assert res.success is True
        assert "没找到" in res.output
        assert res.display["result_count"] == 0
