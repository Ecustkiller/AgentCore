"""Tests for the file_write, file_delete and file_move tools (mutating file ops).

Hermetic: every test runs against a throwaway ``ServerWorkspace`` rooted at
``tmp_path`` and inspects the real on-disk result, mirroring the str_replace tool
tests. These tools are thin shells, so the focus is argument handling and the
typed-failure → user-message mapping (the heavy I/O lives in the backend).
"""

from pathlib import Path

from agentcore.tools.builtin.file_ops import FileDeleteTool, FileMoveTool, FileWriteTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ctx(workspace: Path) -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=workspace, sandbox=SubprocessSandbox()),
        user_id="u",
    )


# --- file_write ---


async def test_write_creates_file(tmp_path: Path):
    result = await FileWriteTool().execute(
        {"path": "notes/report.md", "content": "# Hi"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert (tmp_path / "notes" / "report.md").read_text(encoding="utf-8") == "# Hi"


async def test_write_rejects_empty_path(tmp_path: Path):
    # A worker that omits/empties ``path`` must get a crisp required-arg error — NOT
    # a backend write onto the workspace root dir (the real-world file_write failure:
    # path=None → root → "[Errno 13] Permission denied: <abs server path>").
    (tmp_path / "keep.txt").write_text("keep", encoding="utf-8")
    result = await FileWriteTool().execute({"path": "", "content": "x" * 5000}, _ctx(tmp_path))
    assert result.success is False
    assert "path 不能为空" in result.error
    # the root must be untouched (no clobber, no stray file)
    assert (tmp_path / "keep.txt").read_text(encoding="utf-8") == "keep"


async def test_write_rejects_missing_path(tmp_path: Path):
    result = await FileWriteTool().execute({"content": "body"}, _ctx(tmp_path))
    assert result.success is False
    assert "path 不能为空" in result.error


async def test_write_rejects_path_outside_workspace(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    result = await FileWriteTool().execute({"path": "../escaped.md", "content": "leak"}, _ctx(ws))
    assert result.success is False
    assert "超出了工作区范围" in result.error
    assert not (tmp_path / "escaped.md").exists()


# --- file_delete ---


async def test_delete_file(tmp_path: Path):
    (tmp_path / "f.txt").write_text("bye", encoding="utf-8")
    result = await FileDeleteTool().execute({"path": "f.txt"}, _ctx(tmp_path))
    assert result.success is True
    assert "已删除 f.txt" in result.output
    assert not (tmp_path / "f.txt").exists()


async def test_delete_directory_recursive(tmp_path: Path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "a.txt").write_text("a", encoding="utf-8")
    (tmp_path / "pkg" / "sub").mkdir()
    (tmp_path / "pkg" / "sub" / "b.txt").write_text("b", encoding="utf-8")
    result = await FileDeleteTool().execute({"path": "pkg"}, _ctx(tmp_path))
    assert result.success is True
    assert not (tmp_path / "pkg").exists()


async def test_delete_not_found(tmp_path: Path):
    result = await FileDeleteTool().execute({"path": "nope.txt"}, _ctx(tmp_path))
    assert result.success is False
    assert "路径不存在" in result.error


async def test_delete_rejects_path_outside_workspace(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (tmp_path / "secret.txt").write_text("top secret", encoding="utf-8")
    result = await FileDeleteTool().execute({"path": "../secret.txt"}, _ctx(ws))
    assert result.success is False
    assert "超出了工作区范围" in result.error
    # the out-of-tree file must be untouched
    assert (tmp_path / "secret.txt").read_text(encoding="utf-8") == "top secret"


async def test_delete_refuses_workspace_root(tmp_path: Path):
    (tmp_path / "keep.txt").write_text("keep", encoding="utf-8")
    result = await FileDeleteTool().execute({"path": ""}, _ctx(tmp_path))
    assert result.success is False
    assert "超出了工作区范围" in result.error
    # nothing in the root was removed
    assert (tmp_path / "keep.txt").exists()


# --- file_move ---


async def test_move_renames_file(tmp_path: Path):
    (tmp_path / "old.txt").write_text("data", encoding="utf-8")
    result = await FileMoveTool().execute(
        {"source": "old.txt", "destination": "new.txt"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert "已把 old.txt 移动到 new.txt" in result.output
    assert not (tmp_path / "old.txt").exists()
    assert (tmp_path / "new.txt").read_text(encoding="utf-8") == "data"


async def test_move_creates_destination_parents(tmp_path: Path):
    (tmp_path / "f.txt").write_text("x", encoding="utf-8")
    result = await FileMoveTool().execute(
        {"source": "f.txt", "destination": "deep/nested/f.txt"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert (tmp_path / "deep" / "nested" / "f.txt").read_text(encoding="utf-8") == "x"


async def test_move_directory(tmp_path: Path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.txt").write_text("a", encoding="utf-8")
    result = await FileMoveTool().execute({"source": "src", "destination": "dst"}, _ctx(tmp_path))
    assert result.success is True
    assert (tmp_path / "dst" / "a.txt").read_text(encoding="utf-8") == "a"
    assert not (tmp_path / "src").exists()


async def test_move_refuses_to_overwrite(tmp_path: Path):
    (tmp_path / "a.txt").write_text("from", encoding="utf-8")
    (tmp_path / "b.txt").write_text("to", encoding="utf-8")
    result = await FileMoveTool().execute(
        {"source": "a.txt", "destination": "b.txt"}, _ctx(tmp_path)
    )
    assert result.success is False
    assert "已存在" in result.error
    # both files must be untouched
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "from"
    assert (tmp_path / "b.txt").read_text(encoding="utf-8") == "to"


async def test_move_source_not_found(tmp_path: Path):
    result = await FileMoveTool().execute(
        {"source": "ghost.txt", "destination": "x.txt"}, _ctx(tmp_path)
    )
    assert result.success is False
    assert "源路径不存在" in result.error


async def test_move_rejects_path_outside_workspace(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "inside.txt").write_text("inside", encoding="utf-8")
    result = await FileMoveTool().execute(
        {"source": "inside.txt", "destination": "../escaped.txt"}, _ctx(ws)
    )
    assert result.success is False
    assert "超出了工作区范围" in result.error
    assert (ws / "inside.txt").read_text(encoding="utf-8") == "inside"
    assert not (tmp_path / "escaped.txt").exists()


async def test_move_requires_both_args(tmp_path: Path):
    (tmp_path / "f.txt").write_text("x", encoding="utf-8")
    result = await FileMoveTool().execute({"source": "f.txt"}, _ctx(tmp_path))
    assert result.success is False
    assert "必填" in result.error


async def test_move_rejects_identical_paths(tmp_path: Path):
    (tmp_path / "f.txt").write_text("x", encoding="utf-8")
    result = await FileMoveTool().execute(
        {"source": "f.txt", "destination": "f.txt"}, _ctx(tmp_path)
    )
    assert result.success is False
    assert "相同" in result.error
    assert (tmp_path / "f.txt").read_text(encoding="utf-8") == "x"
