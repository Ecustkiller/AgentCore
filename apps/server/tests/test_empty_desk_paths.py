"""Empty-desk paths are honored: write/read/mkdir use the requested relative path."""

from __future__ import annotations

from pathlib import Path

from agentcore.tools.builtin.file_ops import (
    FileBatchTool,
    FileListTool,
    FileReadTool,
    FileWriteTool,
)
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.desk_empty import desk_is_visibly_empty
from agentcore.workspace.server import ServerWorkspace
from agentcore.workspace.stage_dirs import AGENTCORE_ROOT


def _empty_ctx(workspace: Path, *, agent_id: str = "ceo") -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="s",
        agent_id=agent_id,
        backend=ServerWorkspace(root=workspace, sandbox=SubprocessSandbox()),
        user_id="u",
    )


async def test_empty_desk_write_keeps_requested_dir(tmp_path: Path):
    ctx = _empty_ctx(tmp_path)
    result = await FileWriteTool().execute(
        {"path": "测试/worker-a.md", "content": "hello"}, ctx
    )
    assert result.success is True
    landed = tmp_path / "测试" / "worker-a.md"
    assert landed.read_text(encoding="utf-8") == "hello"
    assert not (tmp_path / "worker-a.md").exists()

    read = await FileReadTool().execute({"path": "测试/worker-a.md"}, ctx)
    assert read.success is True
    assert "hello" in read.output


async def test_empty_desk_mkdir_creates_named_dir(tmp_path: Path):
    ctx = _empty_ctx(tmp_path)
    made = await FileBatchTool().execute(
        {"operations": [{"op": "mkdir", "path": "测试"}]}, ctx
    )
    assert made.success is True
    assert (tmp_path / "测试").is_dir()

    listed = await FileListTool().execute({"directory": "测试"}, ctx)
    assert listed.success is True


async def test_empty_desk_ascii_wrapper_also_kept(tmp_path: Path):
    ctx = _empty_ctx(tmp_path)
    result = await FileWriteTool().execute(
        {"path": "court-game/x", "content": "hello"}, ctx
    )
    assert result.success is True
    assert (tmp_path / "court-game" / "x").read_text(encoding="utf-8") == "hello"
    assert not (tmp_path / "x").exists()


async def test_desk_is_visibly_empty_ignores_agentcore_and_attachments(tmp_path: Path):
    (tmp_path / AGENTCORE_ROOT / "文档" / "工作稿").mkdir(parents=True)
    (tmp_path / AGENTCORE_ROOT / "文档" / "工作稿" / "a.md").write_text(
        "draft\n", encoding="utf-8"
    )
    (tmp_path / "attachments").mkdir()
    (tmp_path / "attachments" / "scan.pdf").write_text("bin", encoding="utf-8")
    backend = ServerWorkspace(root=tmp_path, sandbox=SubprocessSandbox())
    assert await desk_is_visibly_empty(backend) is True

    (tmp_path / "notes").mkdir()
    (tmp_path / "notes" / "keep.md").write_text("keep\n", encoding="utf-8")
    assert await desk_is_visibly_empty(backend) is False
