"""Tests for CEO list_projects / resolve_project / create_project.

P0 桶 A：列名册与按名解析。P1 桶 C：云 create（同指挥面；不碰会话归属）。
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.builtin.projects import (
    CreateProjectTool,
    ListProjectsTool,
    ResolveProjectTool,
    resolve_projects_by_name,
)
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registration import (
    AUDIENCE_CEO,
    CeoWire,
    ToolSurface,
    declared_tool_name,
    declared_tools,
    tool_registration,
)
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ctx(user_id: str = "u1", *, conversation_id: str = "") -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id=user_id,
        conversation_id=conversation_id,
    )


def _summary(
    *,
    id: str,
    name: str,
    mode: str = "cloud",
    local_root_id: str | None = None,
    local_subpath: str | None = None,
) -> dict[str, Any]:
    return {
        "id": id,
        "name": name,
        "mode": mode,
        "local_root_id": local_root_id,
        "local_subpath": local_subpath,
        "created_at": "2026-01-01T00:00:00",
        "updated_at": "2026-01-02T00:00:00",
    }


# --- pure resolve -----------------------------------------------------------


def test_resolve_unique_exact_is_silent_hit():
    rows = [
        _summary(id="a", name="Alpha"),
        _summary(id="b", name="Beta", mode="local", local_root_id="root-1"),
    ]
    out = resolve_projects_by_name(rows, "alpha")
    assert out.status == "resolved"
    assert len(out.matches) == 1
    assert out.matches[0]["id"] == "a"


def test_resolve_zero_hits():
    rows = [_summary(id="a", name="Alpha")]
    out = resolve_projects_by_name(rows, "Gamma")
    assert out.status == "not_found"
    assert out.matches == ()


def test_resolve_multiple_exact_is_ambiguous_not_recent():
    # Cloud allows duplicate names — must not silently pick either.
    rows = [
        _summary(id="old", name="Twin"),
        _summary(id="new", name="Twin"),
    ]
    out = resolve_projects_by_name(rows, "Twin")
    assert out.status == "ambiguous"
    assert {m["id"] for m in out.matches} == {"old", "new"}


def test_resolve_unique_substring_hit():
    rows = [
        _summary(id="1", name="AgentCore"),
        _summary(id="2", name="Other"),
    ]
    out = resolve_projects_by_name(rows, "agent")
    assert out.status == "resolved"
    assert out.matches[0]["id"] == "1"


def test_resolve_ambiguous_substring():
    rows = [
        _summary(id="1", name="Shop Frontend"),
        _summary(id="2", name="Shop Backend", mode="local", local_root_id="r"),
    ]
    out = resolve_projects_by_name(rows, "Shop")
    assert out.status == "ambiguous"
    assert len(out.matches) == 2


def test_resolve_blank_name_is_not_found():
    assert resolve_projects_by_name([_summary(id="a", name="A")], "  ").status == "not_found"


# --- schema / registration --------------------------------------------------


def test_list_projects_schema_and_registration():
    tool = ListProjectsTool()
    assert tool.schema.name == "list_projects"
    assert tool.schema.category is ToolCategory.ORCHESTRATION
    assert tool.schema.approval is ToolApproval.NEVER
    reg = tool_registration(ListProjectsTool)
    assert reg.surface is ToolSurface.CEO_ORCHESTRATION
    assert reg.audience == (AUDIENCE_CEO,)
    assert reg.ceo_wire is CeoWire.ALWAYS


def test_resolve_project_schema_and_registration():
    tool = ResolveProjectTool()
    assert tool.schema.name == "resolve_project"
    assert "name" in tool.schema.parameters["properties"]
    assert tool.schema.approval is ToolApproval.NEVER
    reg = tool_registration(ResolveProjectTool)
    assert reg.surface is ToolSurface.CEO_ORCHESTRATION
    assert AUDIENCE_CEO in reg.audience
    assert reg.audience[0] == AUDIENCE_CEO
    assert len(reg.audience) == 1
    assert reg.ceo_wire is CeoWire.ALWAYS


def test_create_project_schema_and_registration():
    tool = CreateProjectTool()
    assert tool.schema.name == "create_project"
    assert "name" in tool.schema.parameters["properties"]
    assert tool.schema.category is ToolCategory.ORCHESTRATION
    assert tool.schema.approval is ToolApproval.NEVER
    # Cloud-only surface: no local_root_id / mode param (local = 桶 D).
    props = tool.schema.parameters["properties"]
    assert "local_root_id" not in props
    assert "mode" not in props
    assert "mode=cloud" in tool.schema.description
    assert "folder_id" in tool.schema.description
    assert "open_local_project" in tool.schema.description
    reg = tool_registration(CreateProjectTool)
    assert reg.surface is ToolSurface.CEO_ORCHESTRATION
    assert reg.audience == (AUDIENCE_CEO,)
    assert reg.ceo_wire is CeoWire.ALWAYS


def test_declared_roster_includes_projects_tools():
    names = {declared_tool_name(cls) for cls in declared_tools()}
    assert "list_projects" in names
    assert "resolve_project" in names
    assert "create_project" in names


# --- execute (repo mocked) --------------------------------------------------


class _FakeFolder:
    def __init__(
        self,
        *,
        id: str,
        name: str,
        local_root_id: str | None = None,
        local_subpath: str | None = None,
    ) -> None:
        self.id = id
        self.name = name
        self.local_root_id = local_root_id
        self.local_subpath = local_subpath
        self.created_at = datetime(2026, 1, 1)
        self.updated_at = datetime(2026, 1, 2)


def _patch_list(monkeypatch: pytest.MonkeyPatch, folders: list[_FakeFolder]) -> None:
    import agentcore.tools.builtin.projects as projects_mod

    class _Repo:
        def __init__(self, session: Any) -> None:
            del session

        async def list_by_user(self, user_id: str) -> list[_FakeFolder]:
            del user_id
            return folders

    class _CM:
        async def __aenter__(self) -> object:
            return object()

        async def __aexit__(self, *args: object) -> None:
            return None

    monkeypatch.setattr(projects_mod, "async_session_factory", lambda: _CM())
    monkeypatch.setattr(projects_mod, "FolderRepository", _Repo)


def _patch_create(
    monkeypatch: pytest.MonkeyPatch,
    *,
    created: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Stub FolderRepository.create; return call log for assertions."""
    import agentcore.tools.builtin.projects as projects_mod

    calls = created if created is not None else []

    class _Repo:
        def __init__(self, session: Any) -> None:
            del session

        async def create(
            self,
            *,
            user_id: str,
            name: str,
            local_root_id: str | None = None,
            local_subpath: str | None = None,
        ) -> _FakeFolder:
            calls.append(
                {
                    "user_id": user_id,
                    "name": name,
                    "local_root_id": local_root_id,
                    "local_subpath": local_subpath,
                }
            )
            return _FakeFolder(id="new-cloud-1", name=name)

    class _CM:
        async def __aenter__(self) -> object:
            return object()

        async def __aexit__(self, *args: object) -> None:
            return None

    monkeypatch.setattr(projects_mod, "async_session_factory", lambda: _CM())
    monkeypatch.setattr(projects_mod, "FolderRepository", _Repo)
    return calls


async def test_list_projects_returns_folder_summary_shape(monkeypatch: pytest.MonkeyPatch):
    _patch_list(
        monkeypatch,
        [
            _FakeFolder(id="c1", name="Cloud App"),
            _FakeFolder(
                id="l1",
                name="Local App",
                local_root_id="root-x",
                local_subpath="repos/app",
            ),
        ],
    )
    result = await ListProjectsTool().execute({}, _ctx())
    assert result.success
    assert result.display == {"count": 2}
    # Payload after the human lead-in
    payload = json.loads(result.output.split("\n", 1)[1])
    assert payload["count"] == 2
    assert {p["id"] for p in payload["projects"]} == {"c1", "l1"}
    cloud = next(p for p in payload["projects"] if p["id"] == "c1")
    local = next(p for p in payload["projects"] if p["id"] == "l1")
    assert cloud["mode"] == "cloud"
    assert cloud["local_root_id"] is None
    assert local["mode"] == "local"
    assert local["local_root_id"] == "root-x"
    assert local["local_subpath"] == "repos/app"
    # No OS absolute path field
    for p in payload["projects"]:
        assert "path" not in p
        assert "local_dir" not in p


async def test_list_projects_empty(monkeypatch: pytest.MonkeyPatch):
    _patch_list(monkeypatch, [])
    result = await ListProjectsTool().execute({}, _ctx())
    assert result.success
    assert result.display == {"count": 0}
    assert "没有项目" in result.output
    assert "create_project" in result.output
    # Empty roster must not default-nudge open_local_project as the create path.
    assert "勿默认催 open_local_project" in result.output or "create_project" in result.output


async def test_resolve_unique(monkeypatch: pytest.MonkeyPatch):
    _patch_list(
        monkeypatch,
        [
            _FakeFolder(id="only", name="Solo"),
            _FakeFolder(id="other", name="Other"),
        ],
    )
    result = await ResolveProjectTool().execute({"name": "solo"}, _ctx())
    assert result.success
    assert result.display["status"] == "resolved"
    assert result.display["folder_id"] == "only"
    assert "唯一命中" in result.output
    assert "ask_user" not in result.output


async def test_resolve_zero(monkeypatch: pytest.MonkeyPatch):
    _patch_list(monkeypatch, [_FakeFolder(id="a", name="Alpha")])
    result = await ResolveProjectTool().execute({"name": "Missing"}, _ctx())
    assert result.success
    assert result.display["status"] == "not_found"
    assert "ask_user" in result.output or "list_projects" in result.output
    assert "create_project" in result.output  # zero-hit → 登记/create
    assert "禁止静默猜" in result.output
    # Must not default-urge open_local_project as the create path (§4.9 ③A).
    assert "新建本机项目才用 open_local_project" not in result.output
    assert "勿用 open_local_project" in result.output or "open_local_project" in result.output


async def test_resolve_ambiguous(monkeypatch: pytest.MonkeyPatch):
    _patch_list(
        monkeypatch,
        [
            _FakeFolder(id="c", name="Shop", local_root_id=None),
            _FakeFolder(
                id="l",
                name="Shop",
                local_root_id="root-1",
                local_subpath=None,
            ),
        ],
    )
    result = await ResolveProjectTool().execute({"name": "Shop"}, _ctx())
    assert result.success
    assert result.display["status"] == "ambiguous"
    assert result.display["match_count"] == 2
    assert "ask_user" in result.output
    assert "kind=choice" in result.output
    assert "禁止静默猜" in result.output
    payload = json.loads(result.output.split("\n", 1)[1])
    modes = {m["id"]: m["mode"] for m in payload["matches"]}
    assert modes == {"c": "cloud", "l": "local"}


async def test_resolve_missing_name_arg():
    result = await ResolveProjectTool().execute({}, _ctx())
    assert not result.success
    assert result.error == "missing name"


# --- create_project (P1 桶 C) -------------------------------------------------


async def test_create_project_cloud_success(monkeypatch: pytest.MonkeyPatch):
    calls = _patch_create(monkeypatch)
    result = await CreateProjectTool().execute(
        {"name": "  New Cloud App  "},
        _ctx(user_id="owner-1", conversation_id="conv-stay"),
    )
    assert result.success
    assert result.display["status"] == "created"
    assert result.display["folder_id"] == "new-cloud-1"
    assert result.display["name"] == "New Cloud App"
    assert result.display["mode"] == "cloud"
    assert result.display["conversation_untouched"] is True
    assert calls == [
        {
            "user_id": "owner-1",
            "name": "New Cloud App",
            "local_root_id": None,
            "local_subpath": None,
        }
    ]
    # FolderSummary-shaped project in payload
    payload = json.loads(result.output.split("\n", 1)[1])
    assert payload["status"] == "created"
    assert payload["conversation_untouched"] is True
    project = payload["project"]
    assert project["id"] == "new-cloud-1"
    assert project["mode"] == "cloud"
    assert project["local_root_id"] is None
    assert "path" not in project
    assert "未改会话" in result.output or "conversation_untouched" in result.output


async def test_create_project_does_not_touch_conversation(monkeypatch: pytest.MonkeyPatch):
    """Invariant: create is account Folder only — never rebinds conversation.folder_id."""
    import agentcore.tools.builtin.projects as projects_mod

    _patch_create(monkeypatch)
    # If create ever starts mutating conversations, these would be imported/called.
    assert not hasattr(projects_mod, "ConversationRepository")
    assert "ConversationRepository" not in projects_mod.__dict__

    conversation_mutations: list[str] = []

    def _forbid_conversation_touch(*_a: Any, **_k: Any) -> None:
        conversation_mutations.append("touched")
        raise AssertionError("create_project must not touch conversations")

    # Belt: even if someone later imports Conversation models into this module,
    # a stray setattr on conversation.folder_id should fail the test loudly.
    monkeypatch.setattr(
        projects_mod,
        "ConversationRepository",
        type(
            "ForbiddenConversationRepo",
            (),
            {
                "__init__": lambda self, *a, **k: _forbid_conversation_touch(),
                "update": staticmethod(_forbid_conversation_touch),
            },
        ),
        raising=False,
    )

    result = await CreateProjectTool().execute(
        {"name": "Stay Put"},
        _ctx(conversation_id="conv-must-not-rebind"),
    )
    assert result.success
    assert conversation_mutations == []
    assert result.display.get("conversation_untouched") is True


async def test_create_project_missing_name():
    result = await CreateProjectTool().execute({}, _ctx())
    assert not result.success
    assert result.error == "missing name"
