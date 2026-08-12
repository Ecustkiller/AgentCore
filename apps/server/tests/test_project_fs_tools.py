"""CEO read-only cross-desk tools: list_project_dir / read_project_file."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.runtime.delegate.target_desktop import (
    TargetDesktopError,
    TargetFolderBinding,
)
from agentcore.runtime.events import EventSink
from agentcore.tools.builtin.project_fs import (
    ListProjectDirTool,
    ReadProjectFileTool,
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
from agentcore.workspace.locate import LocalBinding
from agentcore.workspace.server import ServerWorkspace


def _birth_backend(tmp_path: Path) -> ServerWorkspace:
    birth = tmp_path / "birth"
    birth.mkdir()
    (birth / "birth_only.txt").write_text("birth", encoding="utf-8")
    return ServerWorkspace(root=birth, sandbox=SubprocessSandbox())


def _target_backend(tmp_path: Path) -> ServerWorkspace:
    target = tmp_path / "target"
    target.mkdir()
    (target / "readme.md").write_text("hello from target\nline2\n", encoding="utf-8")
    (target / "src").mkdir()
    (target / "src" / "a.py").write_text("print(1)\n", encoding="utf-8")
    return ServerWorkspace(root=target, sandbox=SubprocessSandbox())


def _ctx(tmp_path: Path, *, user_id: str = "u1") -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="r",
        agent_id="ceo",
        backend=_birth_backend(tmp_path),
        user_id=user_id,
        conversation_id="conv-birth",
    )


def _local_binding() -> TargetFolderBinding:
    return TargetFolderBinding(
        folder_id="folder_local",
        name="LocalProj",
        local_binding=LocalBinding(
            root_id="root-1",
            root_label="LocalProj",
            subpath="",
        ),
    )


# --- schema / registration --------------------------------------------------


def test_list_project_dir_schema_and_registration():
    tool = ListProjectDirTool()
    assert tool.schema.name == "list_project_dir"
    assert tool.schema.category is ToolCategory.ORCHESTRATION
    assert tool.schema.approval is ToolApproval.NEVER
    props = tool.schema.parameters["properties"]
    assert "folder_id" in props
    assert "directory" in props
    assert "pattern" in props
    assert "recursive" in props
    assert "max_depth" in props
    assert "target_folder_id" not in props
    assert tool.schema.parameters["required"] == ["folder_id"]
    reg = tool_registration(ListProjectDirTool)
    assert reg.surface is ToolSurface.CEO_ORCHESTRATION
    assert reg.audience == (AUDIENCE_CEO,)
    assert reg.ceo_wire is CeoWire.ALWAYS


def test_read_project_file_schema_and_registration():
    tool = ReadProjectFileTool()
    assert tool.schema.name == "read_project_file"
    assert tool.schema.category is ToolCategory.ORCHESTRATION
    assert tool.schema.approval is ToolApproval.NEVER
    props = tool.schema.parameters["properties"]
    assert "folder_id" in props
    assert "path" in props
    assert "offset" in props
    assert "limit" in props
    assert "target_folder_id" not in props
    assert set(tool.schema.parameters["required"]) == {"folder_id", "path"}
    reg = tool_registration(ReadProjectFileTool)
    assert reg.surface is ToolSurface.CEO_ORCHESTRATION
    assert reg.audience == (AUDIENCE_CEO,)
    assert reg.ceo_wire is CeoWire.ALWAYS


def test_declared_roster_includes_project_fs_tools():
    names = {declared_tool_name(cls) for cls in declared_tools()}
    assert "list_project_dir" in names
    assert "read_project_file" in names


def test_no_write_project_fs_variants_on_roster():
    """只读跨桌：禁止写/改/删变体进入名册。"""
    names = {declared_tool_name(cls) for cls in declared_tools()}
    forbidden = {
        "write_project_file",
        "append_project_file",
        "delete_project_file",
        "str_replace_project_file",
        "mkdir_project_dir",
        "file_write_project",
    }
    assert names.isdisjoint(forbidden)


# --- execute ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_and_read_registered_local_folder(tmp_path: Path):
    """CEO can list/read an owned local Folder without touching birth desk."""
    birth_backend = _birth_backend(tmp_path)
    target_backend = _target_backend(tmp_path)
    sink = EventSink()
    ctx = ToolContext.create(
        execution_id="e",
        run_id="r",
        agent_id="ceo",
        backend=birth_backend,
        user_id="u1",
        conversation_id="conv-birth",
        desktop_channel=SimpleNamespace(sink=sink),
    )
    binding = _local_binding()

    with (
        patch(
            "agentcore.tools.builtin.project_fs.load_target_folder_binding",
            new=AsyncMock(return_value=binding),
        ) as load_mock,
        patch(
            "agentcore.tools.builtin.project_fs.build_target_backend",
            return_value=target_backend,
        ) as build_mock,
        patch(
            "agentcore.tools.builtin.project_fs.workspace_channel_for_tools",
            return_value=None,
        ),
    ):
        listed = await ListProjectDirTool().execute(
            {"folder_id": "folder_local", "directory": "."},
            ctx,
        )
        assert listed.success is True
        assert "readme.md" in listed.output
        assert "src" in listed.output

        read = await ReadProjectFileTool().execute(
            {"folder_id": "folder_local", "path": "readme.md"},
            ctx,
        )
        assert read.success is True
        assert "hello from target" in read.output

    load_mock.assert_awaited()
    assert build_mock.call_count >= 1
    # Session birth backend untouched (no mount rewrite).
    assert ctx.backend is birth_backend
    assert (tmp_path / "birth" / "birth_only.txt").read_text(encoding="utf-8") == "birth"
    # Cross-desk did not invent files on birth desk.
    assert not (tmp_path / "birth" / "readme.md").exists()


@pytest.mark.asyncio
async def test_denied_folder_fails(tmp_path: Path):
    ctx = _ctx(tmp_path)
    with patch(
        "agentcore.tools.builtin.project_fs.load_target_folder_binding",
        new=AsyncMock(return_value=None),
    ):
        listed = await ListProjectDirTool().execute(
            {"folder_id": "nope", "directory": "."},
            ctx,
        )
        read = await ReadProjectFileTool().execute(
            {"folder_id": "nope", "path": "x.txt"},
            ctx,
        )
    assert listed.success is False
    assert "无权" in listed.output or "不存在" in listed.output
    assert listed.error == "folder_denied"
    assert read.success is False
    assert "无权" in read.output or "不存在" in read.output


@pytest.mark.asyncio
async def test_target_desktop_error_surfaces(tmp_path: Path):
    ctx = _ctx(tmp_path)
    with patch(
        "agentcore.tools.builtin.project_fs.load_target_folder_binding",
        new=AsyncMock(side_effect=TargetDesktopError("无法绑定目标项目。数据库不可用")),
    ):
        result = await ListProjectDirTool().execute(
            {"folder_id": "f1"},
            ctx,
        )
    assert result.success is False
    assert "无法绑定目标项目" in result.output
    assert result.error == "target_desktop_error"


@pytest.mark.asyncio
async def test_local_folder_without_channel_fails(tmp_path: Path):
    """Local binding needs turn sink/channel; no silent forge."""
    ctx = _ctx(tmp_path)  # no desktop_channel / workspace_channel
    with patch(
        "agentcore.tools.builtin.project_fs.load_target_folder_binding",
        new=AsyncMock(return_value=_local_binding()),
    ):
        result = await ReadProjectFileTool().execute(
            {"folder_id": "folder_local", "path": "readme.md"},
            ctx,
        )
    assert result.success is False
    assert result.error == "workspace_channel_unavailable"
    assert "通道" in result.output or "桌面" in result.output


@pytest.mark.asyncio
async def test_missing_folder_id(tmp_path: Path):
    ctx = _ctx(tmp_path)
    result = await ListProjectDirTool().execute({"directory": "."}, ctx)
    assert result.success is False
    assert result.error == "missing folder_id"


@pytest.mark.asyncio
async def test_does_not_call_apply_target_desktop(tmp_path: Path):
    """Read-only cross-desk must not rewrite target-desk memory via apply_*."""
    target_backend = _target_backend(tmp_path)
    sink = EventSink()
    ctx = ToolContext.create(
        execution_id="e",
        run_id="r",
        agent_id="ceo",
        backend=_birth_backend(tmp_path),
        user_id="u1",
        conversation_id="conv-birth",
        desktop_channel=SimpleNamespace(sink=sink),
    )
    with (
        patch(
            "agentcore.tools.builtin.project_fs.load_target_folder_binding",
            new=AsyncMock(return_value=_local_binding()),
        ),
        patch(
            "agentcore.tools.builtin.project_fs.build_target_backend",
            return_value=target_backend,
        ),
        patch(
            "agentcore.tools.builtin.project_fs.workspace_channel_for_tools",
            return_value=None,
        ),
        patch(
            "agentcore.runtime.delegate.target_desktop.apply_target_desktop",
            new=AsyncMock(),
        ) as apply_mock,
    ):
        await ReadProjectFileTool().execute(
            {"folder_id": "folder_local", "path": "readme.md"},
            ctx,
        )
    apply_mock.assert_not_called()


def test_generic_file_tools_have_no_folder_id_param():
    from agentcore.tools.builtin.file_ops import FileListTool, FileReadTool

    for tool in (FileListTool(), FileReadTool()):
        props = tool.schema.parameters.get("properties") or {}
        assert "folder_id" not in props
        assert "target_folder_id" not in props
