"""Tests for the file_write, file_delete and file_move tools (mutating file ops).

Hermetic: every test runs against a throwaway ``ServerWorkspace`` rooted at
``tmp_path`` and inspects the real on-disk result, mirroring the str_replace tool
tests. These tools are thin shells, so the focus is argument handling and the
typed-failure → user-message mapping (the heavy I/O lives in the backend).
"""

from pathlib import Path

from agentcore.tools.builtin.file_ops import (
    FileAppendTool,
    FileBatchTool,
    FileCopyTool,
    FileDeleteTool,
    FileMoveTool,
    FileWriteTool,
    MkdirTool,
)
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


# --- file_append ---


async def test_append_creates_file_when_missing(tmp_path: Path):
    result = await FileAppendTool().execute(
        {"path": "draft.md", "content": "# Intro"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert (tmp_path / "draft.md").read_text(encoding="utf-8") == "# Intro"


async def test_append_adds_to_existing_file(tmp_path: Path):
    (tmp_path / "draft.md").write_text("# Intro", encoding="utf-8")
    result = await FileAppendTool().execute(
        {"path": "draft.md", "content": "\n\n## Section 2"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert (tmp_path / "draft.md").read_text(encoding="utf-8") == "# Intro\n\n## Section 2"


async def test_append_rejects_empty_path(tmp_path: Path):
    result = await FileAppendTool().execute({"path": "", "content": "x"}, _ctx(tmp_path))
    assert result.success is False
    assert "path 不能为空" in result.error


async def test_append_rejects_directory_target(tmp_path: Path):
    (tmp_path / "pkg").mkdir()
    result = await FileAppendTool().execute({"path": "pkg", "content": "x"}, _ctx(tmp_path))
    assert result.success is False
    assert "不是文件" in result.error


async def test_append_receipt_echoes_merged_tail(tmp_path: Path):
    # append 只写增量、模型上下文没有合并后的全文；回执必须回显「文件当前末尾」，让 worker 当轮
    # 确认「追加落对没」，免掉那一轮纯回读自检（trace 4d715ea0 里 8 个 append worker 的空转来源）。
    (tmp_path / "draft.md").write_text("# Intro", encoding="utf-8")
    result = await FileAppendTool().execute(
        {"path": "draft.md", "content": "\n\n## Section 2"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert "## Section 2" in result.output  # 合并后的新末尾被回显
    assert "无需再读回确认" in result.output


async def test_write_receipt_notes_persisted(tmp_path: Path):
    # file_write 内容即模型本次提交的全文，无需回显；回执点明「已落盘、无需回读」以抑制自检回读。
    result = await FileWriteTool().execute(
        {"path": "report.md", "content": "# Hi"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert "无需再读回确认" in result.output


# --- file_delete ---


async def test_delete_file(tmp_path: Path):
    (tmp_path / "f.txt").write_text("bye", encoding="utf-8")
    result = await FileDeleteTool().execute({"path": "f.txt"}, _ctx(tmp_path))
    assert result.success is True
    assert "可逆删除" in result.output
    assert not (tmp_path / "f.txt").exists()
    # Soft-deleted into workspace trash with restore metadata.
    trash = tmp_path / ".agentcore" / "trash"
    assert trash.is_dir()
    entries = list(trash.iterdir())
    assert len(entries) == 1
    assert (entries[0] / "meta.json").is_file()
    assert (entries[0] / "content").read_text(encoding="utf-8") == "bye"


async def test_delete_directory_recursive(tmp_path: Path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "a.txt").write_text("a", encoding="utf-8")
    (tmp_path / "pkg" / "sub").mkdir()
    (tmp_path / "pkg" / "sub" / "b.txt").write_text("b", encoding="utf-8")
    result = await FileDeleteTool().execute({"path": "pkg"}, _ctx(tmp_path))
    assert result.success is True
    assert not (tmp_path / "pkg").exists()
    assert (tmp_path / ".agentcore" / "trash").is_dir()


async def test_delete_permanent_hard_removes(tmp_path: Path):
    (tmp_path / "f.txt").write_text("bye", encoding="utf-8")
    result = await FileDeleteTool().execute(
        {"path": "f.txt", "permanent": True}, _ctx(tmp_path)
    )
    assert result.success is True
    assert "永久删除" in result.output
    assert not (tmp_path / "f.txt").exists()
    trash = tmp_path / ".agentcore" / "trash"
    assert not trash.exists() or not any(trash.iterdir())


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


# --- file_copy / mkdir / file_batch ---


async def test_copy_file_and_tree(tmp_path: Path):
    (tmp_path / "a.txt").write_text("data", encoding="utf-8")
    result = await FileCopyTool().execute(
        {"source": "a.txt", "destination": "b/c.txt"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "data"
    assert (tmp_path / "b" / "c.txt").read_text(encoding="utf-8") == "data"

    (tmp_path / "tree" / "sub").mkdir(parents=True)
    (tmp_path / "tree" / "sub" / "x.bin").write_bytes(b"\x00\xff")
    result = await FileCopyTool().execute(
        {"source": "tree", "destination": "tree2"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert (tmp_path / "tree2" / "sub" / "x.bin").read_bytes() == b"\x00\xff"


async def test_copy_refuses_overwrite(tmp_path: Path):
    (tmp_path / "a.txt").write_text("from", encoding="utf-8")
    (tmp_path / "b.txt").write_text("to", encoding="utf-8")
    result = await FileCopyTool().execute(
        {"source": "a.txt", "destination": "b.txt"}, _ctx(tmp_path)
    )
    assert result.success is False
    assert "已存在" in result.error


async def test_mkdir_creates_and_refuses_existing(tmp_path: Path):
    result = await MkdirTool().execute({"path": "out/docs"}, _ctx(tmp_path))
    assert result.success is True
    assert (tmp_path / "out" / "docs").is_dir()
    result = await MkdirTool().execute({"path": "out/docs"}, _ctx(tmp_path))
    assert result.success is False
    assert "已存在" in result.error


async def test_file_batch_partial_failure_continues(tmp_path: Path):
    (tmp_path / "a.txt").write_text("a", encoding="utf-8")
    result = await FileBatchTool().execute(
        {
            "operations": [
                {"op": "mkdir", "path": "out"},
                {"op": "copy", "source": "a.txt", "destination": "out/a.txt"},
                {"op": "move", "source": "missing.txt", "destination": "out/m.txt"},
                {"op": "delete", "path": "ghost.txt"},
                {"op": "mkdir", "path": "out"},  # already exists → skip
            ]
        },
        _ctx(tmp_path),
    )
    assert result.success is False  # one hard failure (move missing)
    assert "本次共 5 项" in result.output
    assert "成功" in result.output
    assert "跳过" in result.output
    assert "失败" in result.output
    assert (tmp_path / "out" / "a.txt").read_text(encoding="utf-8") == "a"
    assert result.metadata["ok"] >= 2
    assert result.metadata["fail"] >= 1
