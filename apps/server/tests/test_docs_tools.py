"""docs_read / docs_write — creation-tool 文档 (not memory documents, not workspace files)."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from agentcore.core.types import ToolApproval, ToolFace
from agentcore.doc.body import MAX_MARKDOWN_CHARS
from agentcore.doc.tool_access import (
    DEFAULT_TITLE,
    LOCAL_DESK,
    NO_DESK,
    NO_FOLDER,
    NO_WRITE,
    NOT_FOUND,
    TOO_LONG,
    resolve_folder_id,
)
from agentcore.folders.desk import DeskAccess
from agentcore.tools.builtin.docs_read import DocsReadTool
from agentcore.tools.builtin.docs_write import DocsWriteTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    ToolSurface,
    tool_registration,
)


def _ctx(
    *,
    user_id: str = "u1",
    ownership_desk_id: str | None = "f1",
    auto_desk_folder_id: str | None = None,
) -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=SimpleNamespace(location="local"),  # type: ignore[arg-type]
        user_id=user_id,
        ownership_desk_id=ownership_desk_id,
        auto_desk_folder_id=auto_desk_folder_id,
    )


def _folder(*, local: bool = False, name: str = "方案") -> SimpleNamespace:
    return SimpleNamespace(
        id="f1",
        name=name,
        user_id="u1",
        local_root_id="root-1" if local else None,
    )


def _doc(**kw: Any) -> SimpleNamespace:
    return SimpleNamespace(
        id=kw.get("id", "d1"),
        title=kw.get("title", "Q3"),
        folder_id=kw.get("folder_id", "f1"),
        body=kw.get("body", {"markdown": "# hi"}),
        version=kw.get("version", 1),
        updated_at=kw.get("updated_at", "2026-01-02T00:00:00"),
    )


class _CM:
    async def __aenter__(self) -> object:
        return object()

    async def __aexit__(self, *args: object) -> None:
        return None


def _patch_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "agentcore.db.base.async_session_factory", lambda: _CM()
    )


def test_registration_and_schema_contract():
    read = DocsReadTool()
    write = DocsWriteTool()
    assert read.schema.name == "docs_read"
    assert write.schema.name == "docs_write"
    assert read.schema.face is ToolFace.DOC
    assert write.schema.face is ToolFace.DOC
    assert read.schema.approval is ToolApproval.NEVER
    assert write.schema.approval is ToolApproval.NEVER
    read_reg = tool_registration(DocsReadTool)
    write_reg = tool_registration(DocsWriteTool)
    assert read_reg.surface is ToolSurface.BUILTIN
    assert write_reg.surface is ToolSurface.BUILTIN
    assert read_reg.audience == AUDIENCE_BOTH
    assert write_reg.audience == AUDIENCE_BOTH
    assert read_reg.resident is False
    assert write_reg.resident is False
    assert read_reg.catalog_summary == "读创作文档"
    assert write_reg.catalog_summary == "写创作文档"
    assert "HOW→consult" not in read.schema.description
    assert "HOW→consult" not in write.schema.description
    assert "file_write" in write.schema.description
    assert "公开页" in write.schema.description
    assert "publish" not in write.schema.parameters["properties"]
    assert "shares" not in write.schema.parameters["properties"]


def test_resolve_folder_id_prefers_arg_then_ownership_then_auto():
    ctx = _ctx(ownership_desk_id="own", auto_desk_folder_id="auto")
    assert resolve_folder_id({"folder_id": " arg "}, ctx) == "arg"
    assert resolve_folder_id({}, ctx) == "own"
    assert resolve_folder_id({}, _ctx(ownership_desk_id=None, auto_desk_folder_id="auto")) == "auto"
    assert resolve_folder_id({}, _ctx(ownership_desk_id=None, auto_desk_folder_id=None)) is None


async def test_read_without_desk_errors():
    result = await DocsReadTool().execute({}, _ctx(ownership_desk_id=None))
    assert not result.success
    assert result.error == NO_DESK


async def test_write_without_desk_errors():
    result = await DocsWriteTool().execute(
        {"markdown": "# a"}, _ctx(ownership_desk_id=None)
    )
    assert not result.success
    assert result.error == NO_DESK


async def test_markdown_too_long_errors():
    result = await DocsWriteTool().execute(
        {"markdown": "x" * (MAX_MARKDOWN_CHARS + 1)}, _ctx()
    )
    assert not result.success
    assert result.error == TOO_LONG


async def test_list_unknown_folder(monkeypatch: pytest.MonkeyPatch):
    _patch_session(monkeypatch)

    async def _none(*_a: Any, **_kw: Any) -> None:
        return None

    monkeypatch.setattr("agentcore.doc.tool_access.resolve_desk_access", _none)
    result = await DocsReadTool().execute({}, _ctx())
    assert not result.success
    assert result.error == NO_FOLDER


async def test_list_local_folder_rejected(monkeypatch: pytest.MonkeyPatch):
    _patch_session(monkeypatch)

    async def _local(*_a: Any, **_kw: Any) -> DeskAccess:
        return DeskAccess(folder=_folder(local=True), role="owner")  # type: ignore[arg-type]

    monkeypatch.setattr("agentcore.doc.tool_access.resolve_desk_access", _local)
    result = await DocsReadTool().execute({}, _ctx())
    assert not result.success
    assert result.error == LOCAL_DESK


async def test_write_viewer_rejected(monkeypatch: pytest.MonkeyPatch):
    _patch_session(monkeypatch)

    async def _viewer(*_a: Any, **_kw: Any) -> DeskAccess:
        return DeskAccess(folder=_folder(), role="viewer")  # type: ignore[arg-type]

    monkeypatch.setattr("agentcore.doc.tool_access.resolve_desk_access", _viewer)
    result = await DocsWriteTool().execute({"markdown": "# a", "title": "Q3"}, _ctx())
    assert not result.success
    assert result.error == NO_WRITE


async def test_list_empty(monkeypatch: pytest.MonkeyPatch):
    _patch_session(monkeypatch)

    async def _owner(*_a: Any, **_kw: Any) -> DeskAccess:
        return DeskAccess(folder=_folder(), role="owner")  # type: ignore[arg-type]

    class _Repo:
        def __init__(self, _session: object) -> None:
            pass

        async def list_visible(self, _user_id: str, *, folder_id: str | None = None):
            assert folder_id == "f1"
            return []

    monkeypatch.setattr("agentcore.doc.tool_access.resolve_desk_access", _owner)
    monkeypatch.setattr("agentcore.db.repositories.docs.DocRepository", _Repo)
    result = await DocsReadTool().execute({}, _ctx())
    assert result.success
    assert "还没有创作文档" in result.output
    assert result.display == {"count": 0}


async def test_list_and_get(monkeypatch: pytest.MonkeyPatch):
    _patch_session(monkeypatch)
    live = _doc()

    async def _owner(*_a: Any, **_kw: Any) -> DeskAccess:
        return DeskAccess(folder=_folder(), role="owner")  # type: ignore[arg-type]

    class _Repo:
        def __init__(self, _session: object) -> None:
            pass

        async def list_visible(self, _user_id: str, *, folder_id: str | None = None):
            return [(live, "方案", True)]

        async def get_live(self, doc_id: str):
            assert doc_id == "d1"
            return live

    monkeypatch.setattr("agentcore.doc.tool_access.resolve_desk_access", _owner)
    monkeypatch.setattr("agentcore.db.repositories.docs.DocRepository", _Repo)
    listed = await DocsReadTool().execute({}, _ctx())
    assert listed.success
    payload = json.loads(listed.output)
    assert payload["count"] == 1
    assert payload["docs"][0]["id"] == "d1"
    got = await DocsReadTool().execute({"doc_id": "d1"}, _ctx())
    assert got.success
    detail = json.loads(got.output)
    assert detail["markdown"] == "# hi"
    assert detail["version"] == 1


async def test_get_missing(monkeypatch: pytest.MonkeyPatch):
    _patch_session(monkeypatch)

    class _Repo:
        def __init__(self, _session: object) -> None:
            pass

        async def get_live(self, _doc_id: str):
            return None

    monkeypatch.setattr("agentcore.db.repositories.docs.DocRepository", _Repo)
    result = await DocsReadTool().execute({"doc_id": "missing"}, _ctx())
    assert not result.success
    assert result.error == NOT_FOUND


async def test_create_and_save(monkeypatch: pytest.MonkeyPatch):
    _patch_session(monkeypatch)
    created = _doc(title=DEFAULT_TITLE, body={"markdown": ""}, version=1)

    async def _owner(*_a: Any, **_kw: Any) -> DeskAccess:
        return DeskAccess(folder=_folder(), role="owner")  # type: ignore[arg-type]

    class _Repo:
        def __init__(self, _session: object) -> None:
            pass

        async def create(self, *, user_id: str, folder_id: str, title: str):
            assert user_id == "u1"
            assert folder_id == "f1"
            created.title = title
            return created

        async def save_body(self, doc, *, body: dict, baseline: int | None):
            doc.body = body
            doc.version += 1
            return doc, False

        async def update_meta(self, doc, *, title: str | None = None):
            if title is not None:
                doc.title = title
            return doc

        async def get_live(self, _doc_id: str):
            return created

    monkeypatch.setattr("agentcore.doc.tool_access.resolve_desk_access", _owner)
    monkeypatch.setattr("agentcore.db.repositories.docs.DocRepository", _Repo)
    made = await DocsWriteTool().execute(
        {"title": "Q3", "markdown": "# 结论"}, _ctx()
    )
    assert made.success
    assert "已新建" in made.output
    assert "未发布" in made.output
    assert made.display["doc_id"] == "d1"
    saved = await DocsWriteTool().execute(
        {"doc_id": "d1", "markdown": "# 改", "baseline": 2}, _ctx()
    )
    assert saved.success
    assert "version=3" in saved.output


async def test_save_conflict(monkeypatch: pytest.MonkeyPatch):
    _patch_session(monkeypatch)
    live = _doc(version=3)

    async def _owner(*_a: Any, **_kw: Any) -> DeskAccess:
        return DeskAccess(folder=_folder(), role="owner")  # type: ignore[arg-type]

    class _Repo:
        def __init__(self, _session: object) -> None:
            pass

        async def get_live(self, _doc_id: str):
            return live

        async def save_body(self, doc, *, body: dict, baseline: int | None):
            return doc, True

    monkeypatch.setattr("agentcore.doc.tool_access.resolve_desk_access", _owner)
    monkeypatch.setattr("agentcore.db.repositories.docs.DocRepository", _Repo)
    result = await DocsWriteTool().execute(
        {"doc_id": "d1", "markdown": "# x", "baseline": 1}, _ctx()
    )
    assert not result.success
    assert result.error is not None
    assert "版本冲突" in result.error
    assert "version=3" in result.error
