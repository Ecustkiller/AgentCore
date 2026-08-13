"""Async entry ``description`` fill: empty-only, never overwrite, save never waits on LLM."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import agentcore.billing.gate as gate_mod
import agentcore.db.base as db_base
import agentcore.db.repositories as repos_mod
import agentcore.documents.description as desc_mod
from agentcore.documents.description import (
    DESCRIPTION_MAX_CHARS,
    DescriptionInput,
    DescriptionResult,
    LLMDescriptionGenerator,
    _parse_description_result,
    _sanitize_description,
    entry_needs_description_fill,
    maybe_schedule_description_fill,
    schedule_description_generation,
)
from agentcore.documents.frontmatter import (
    ParsedFrontmatter,
    parse_entry_frontmatter,
    set_entry_frontmatter,
)
from agentcore.llm import LLMRequest, LLMResponse


def test_sanitize_strips_label_and_quotes():
    assert _sanitize_description('摘要："用户偏好"') == "用户偏好"
    assert _sanitize_description("description: Foo bar.") == "Foo bar"


def test_sanitize_truncates():
    long = "摘" * (DESCRIPTION_MAX_CHARS + 5)
    out = _sanitize_description(long)
    assert out == "摘" * DESCRIPTION_MAX_CHARS + "…"


def test_parse_json_description():
    assert _parse_description_result('{"description":"项目导航"}') == DescriptionResult(
        description="项目导航"
    )


def test_parse_broken_json_returns_empty():
    assert _parse_description_result('{"description') == DescriptionResult(description="")


def test_entry_needs_fill_only_when_empty_document_with_body():
    content = "---\napply: always\n---\n- 必须用中文\n"
    assert entry_needs_description_fill(kind="document", description="", content=content)
    assert not entry_needs_description_fill(
        kind="document", description="已有", content=content
    )
    assert not entry_needs_description_fill(kind="folder", description="", content=content)
    assert not entry_needs_description_fill(
        kind="document", description="", content="---\napply: always\n---\n"
    )
    assert not entry_needs_description_fill(
        kind="document", description="", content="---\napply: always\nno close"
    )
    # User-written frontmatter description blocks fill even if column is empty.
    with_fm = "---\napply: always\ndescription: 手写\n---\n- 正文\n"
    assert not entry_needs_description_fill(
        kind="document", description="", content=with_fm
    )


def test_user_frontmatter_description_still_writes_into_body():
    """User-authored description remains a frontmatter field (AI fill does not use this path)."""
    original = "---\napply: on_demand\n---\n厚知识\n"
    filled = set_entry_frontmatter(original, description="领域厚知识")
    parsed = parse_entry_frontmatter(filled)
    assert isinstance(parsed, ParsedFrontmatter)
    assert parsed.description == "领域厚知识"
    assert "description: 领域厚知识" in filled


async def test_generator_returns_description():
    class _Prov:
        async def complete(self, request: LLMRequest) -> LLMResponse:
            return LLMResponse(content='{"description":"沟通与习惯偏好"}')

    result = await LLMDescriptionGenerator(_Prov()).generate(
        DescriptionInput(document_id="d1", name="偏好.md", body="- 用中文回复")
    )
    assert result == DescriptionResult(description="沟通与习惯偏好")


async def test_generator_empty_body_skips_llm():
    class _Boom:
        async def complete(self, _request: LLMRequest) -> LLMResponse:
            raise AssertionError("must not call LLM for empty body")

    result = await LLMDescriptionGenerator(_Boom()).generate(
        DescriptionInput(document_id="d1", name="空.md", body="  \n")
    )
    assert result == DescriptionResult(description="")


async def test_schedule_does_not_block_caller(monkeypatch):
    gate = asyncio.Event()
    finished = asyncio.Event()

    async def _slow(**_kwargs):
        try:
            await gate.wait()
            finished.set()
        finally:
            desc_mod._inflight.discard("doc-1")

    monkeypatch.setattr(desc_mod, "_mint_description_background", _slow)
    desc_mod._inflight.clear()

    schedule_description_generation(document_id="doc-1", user_id="u1")
    assert "doc-1" in desc_mod._inflight
    gate.set()
    await asyncio.wait_for(finished.wait(), 1)
    await asyncio.sleep(0)
    assert "doc-1" not in desc_mod._inflight


async def test_schedule_binds_account_level_billing_context(monkeypatch):
    """The fill task inherits the billing envelope that makes its spend visible.

    ``user_id`` is who the per-call quota gate charges; ``cost_role=assist`` +
    ``persona`` are what the call meter stamps onto the ledger row. A document
    belongs to no conversation, so ``conversation_id`` stays unbound and the row
    lands account-level rather than mis-filed onto an unrelated chat (STD-A2).
    """
    from agentcore.core.log_context import get_log_value
    from agentcore.costing import PERSONA_DESCRIPTION, ROLE_ASSIST

    seen: dict[str, str] = {}
    done = asyncio.Event()

    async def _capture(**_kwargs):
        try:
            seen["user_id"] = get_log_value("user_id")
            seen["cost_role"] = get_log_value("cost_role")
            seen["persona"] = get_log_value("persona")
            seen["conversation_id"] = get_log_value("conversation_id")
            done.set()
        finally:
            desc_mod._inflight.discard("doc-ctx")

    monkeypatch.setattr(desc_mod, "_mint_description_background", _capture)
    desc_mod._inflight.clear()

    schedule_description_generation(document_id="doc-ctx", user_id="u-7")
    await asyncio.wait_for(done.wait(), 1)

    assert seen["user_id"] == "u-7"
    assert seen["cost_role"] == ROLE_ASSIST
    assert seen["persona"] == PERSONA_DESCRIPTION
    assert seen["conversation_id"] == ""
    # Scoped bind: scheduling must not leave the context set on the caller.
    assert get_log_value("cost_role") == ""


async def test_maybe_schedule_skips_nonempty(monkeypatch):
    called: list[str] = []

    def _sched(**kwargs):
        called.append(kwargs["document_id"])

    monkeypatch.setattr(desc_mod, "schedule_description_generation", _sched)
    content = "---\napply: on_demand\ndescription: 手写摘要\n---\n正文\n"
    maybe_schedule_description_fill(
        document_id="d1",
        user_id="u1",
        kind="document",
        description="手写摘要",
        content=content,
    )
    assert called == []


async def test_maybe_schedule_fires_when_empty(monkeypatch):
    called: list[str] = []

    def _sched(**kwargs):
        called.append(kwargs["document_id"])

    monkeypatch.setattr(desc_mod, "schedule_description_generation", _sched)
    content = "---\napply: always\n---\n- 规则\n"
    maybe_schedule_description_fill(
        document_id="d2",
        user_id="u1",
        kind="document",
        description="",
        content=content,
    )
    assert called == ["d2"]


class _SessionCM:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, *_a):
        return False


async def test_mint_writes_only_when_empty(monkeypatch):
    """Empty → column-only write; non-empty → never overwrite; content untouched."""
    writes: list[str] = []
    state = {"description": "", "content": "---\napply: always\n---\n正文讲偏好\n"}

    class _Repo:
        def __init__(self, _session):
            pass

        async def get(self, document_id, *, user_id):
            return SimpleNamespace(
                id=document_id,
                kind="document",
                name="偏好.md",
                description=state["description"],
                content=state["content"],
            )

        async def apply_description_if_empty(
            self, document_id, *, user_id, description, expected_content=None
        ):
            if expected_content is not None and state["content"] != expected_content:
                return None
            parsed = parse_entry_frontmatter(state["content"])
            assert isinstance(parsed, ParsedFrontmatter)
            if parsed.description.strip() or state["description"].strip():
                return SimpleNamespace(
                    description=state["description"] or parsed.description
                )
            state["description"] = description
            writes.append(description)
            return SimpleNamespace(description=description)

    async def _bg(user_id, *, purpose, runner):
        return SimpleNamespace(
            value=DescriptionResult(description="AI拟的摘要"),
            credentials=SimpleNamespace(source="platform", default_model="deepseek-v4-flash"),
        )

    monkeypatch.setattr(db_base, "async_session_factory", lambda: _SessionCM())
    monkeypatch.setattr(repos_mod, "DocumentRepository", _Repo)
    monkeypatch.setattr(gate_mod, "run_background_llm", _bg)

    content_before = state["content"]
    out = await desc_mod._mint_description_core(document_id="d1", user_id="u1")
    assert out == "AI拟的摘要"
    assert writes == ["AI拟的摘要"]
    assert state["content"] == content_before
    assert "description:" not in state["content"]

    writes.clear()
    out2 = await desc_mod._mint_description_core(document_id="d1", user_id="u1")
    assert out2 == "AI拟的摘要"
    assert writes == []
    assert state["content"] == content_before


async def test_mint_regenerates_after_clear(monkeypatch):
    state = {
        "description": "",
        "content": "---\napply: always\ndescription:\n---\n新正文\n",
    }
    writes: list[str] = []

    class _Repo:
        def __init__(self, _session):
            pass

        async def get(self, document_id, *, user_id):
            return SimpleNamespace(
                id=document_id,
                kind="document",
                name="规则.md",
                description=state["description"],
                content=state["content"],
            )

        async def apply_description_if_empty(
            self, document_id, *, user_id, description, expected_content=None
        ):
            if expected_content is not None and state["content"] != expected_content:
                return None
            if state["description"].strip():
                return SimpleNamespace(description=state["description"])
            state["description"] = description
            writes.append(description)
            return SimpleNamespace(description=description)

    async def _bg(user_id, *, purpose, runner):
        return SimpleNamespace(
            value=DescriptionResult(description="清空后重生成"),
            credentials=SimpleNamespace(source="platform", default_model="m"),
        )

    monkeypatch.setattr(db_base, "async_session_factory", lambda: _SessionCM())
    monkeypatch.setattr(repos_mod, "DocumentRepository", _Repo)
    monkeypatch.setattr(gate_mod, "run_background_llm", _bg)

    out = await desc_mod._mint_description_core(document_id="d-clear", user_id="u1")
    assert out == "清空后重生成"
    assert writes == ["清空后重生成"]
    assert "清空后重生成" not in state["content"]


async def test_mint_skips_when_content_changed(monkeypatch):
    """Stale generation must not write after the user saves a new body."""
    state = {
        "description": "",
        "content": "---\napply: always\n---\nv1\n",
    }
    snapshot = state["content"]
    writes: list[str] = []

    class _Repo:
        def __init__(self, _session):
            pass

        async def get(self, document_id, *, user_id):
            return SimpleNamespace(
                id=document_id,
                kind="document",
                name="x.md",
                description=state["description"],
                content=state["content"],
            )

        async def apply_description_if_empty(
            self, document_id, *, user_id, description, expected_content=None
        ):
            if expected_content is not None and state["content"] != expected_content:
                return None
            state["description"] = description
            writes.append(description)
            return SimpleNamespace(description=description)

    async def _bg(user_id, *, purpose, runner):
        # Simulate a concurrent save while the LLM runs.
        state["content"] = "---\napply: always\n---\nv2\n"
        return SimpleNamespace(
            value=DescriptionResult(description="针对 v1"),
            credentials=SimpleNamespace(source="platform", default_model="m"),
        )

    monkeypatch.setattr(db_base, "async_session_factory", lambda: _SessionCM())
    monkeypatch.setattr(repos_mod, "DocumentRepository", _Repo)
    monkeypatch.setattr(gate_mod, "run_background_llm", _bg)

    out = await desc_mod._mint_description_core(document_id="d-race", user_id="u1")
    assert out is None
    assert writes == []
    assert state["description"] == ""
    assert state["content"] != snapshot

async def test_mint_llm_unavailable_leaves_empty(monkeypatch):
    state = {
        "description": "",
        "content": "---\napply: always\n---\n正文\n",
    }

    class _Repo:
        def __init__(self, _session):
            pass

        async def get(self, document_id, *, user_id):
            return SimpleNamespace(
                id=document_id,
                kind="document",
                name="x.md",
                description=state["description"],
                content=state["content"],
            )

        async def apply_description_if_empty(self, *_a, **_k):
            raise AssertionError("must not write when LLM unavailable")

    async def _bg(*_a, **_k):
        return None

    monkeypatch.setattr(db_base, "async_session_factory", lambda: _SessionCM())
    monkeypatch.setattr(repos_mod, "DocumentRepository", _Repo)
    monkeypatch.setattr(gate_mod, "run_background_llm", _bg)

    out = await desc_mod._mint_description_core(document_id="d-no-llm", user_id="u1")
    assert out is None
    assert state["description"] == ""


async def test_save_path_succeeds_when_llm_unavailable(monkeypatch):
    """Document write returns ok even if background fill cannot run (定案: 异步)."""
    scheduled: list[str] = []

    def _sched(**kwargs):
        scheduled.append(kwargs["document_id"])

    monkeypatch.setattr(desc_mod, "schedule_description_generation", _sched)

    content = "---\napply: always\n---\n- must use Chinese\n"
    maybe_schedule_description_fill(
        document_id="saved-1",
        user_id="u1",
        kind="document",
        description="",
        content=content,
    )
    assert scheduled == ["saved-1"]
