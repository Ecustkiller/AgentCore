"""Tests for ServerWorkspace — the cloud-mode WorkspaceBackend.

Hermetic: every test builds a throwaway tree under ``tmp_path`` and points the
backend's root at it, so the traversal guard, file I/O, and the typed error
contract are exercised without touching the real repo. The ``execute`` test also
pins the cwd fix: code runs in the workspace root and can read workspace files.
"""

from pathlib import Path

import pytest

from agentcore.tools.sandbox.protocol import ExecutionRequest
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.protocol import (
    AmbiguousMatch,
    GrepQuery,
    NoMatch,
    NotADirectory,
    NotAFile,
    NotUTF8,
    OutsideWorkspace,
    PathNotFound,
)
from agentcore.workspace.server import ServerWorkspace


def _ws(root: Path) -> ServerWorkspace:
    return ServerWorkspace(root=root, sandbox=SubprocessSandbox())


# --- read ---


async def test_read_returns_content(tmp_path: Path):
    (tmp_path / "a.txt").write_text("hello", encoding="utf-8")
    assert await _ws(tmp_path).read("a.txt") == "hello"


async def test_read_missing_raises_path_not_found(tmp_path: Path):
    with pytest.raises(PathNotFound):
        await _ws(tmp_path).read("nope.txt")


async def test_read_directory_raises_not_a_file(tmp_path: Path):
    (tmp_path / "sub").mkdir()
    with pytest.raises(NotAFile):
        await _ws(tmp_path).read("sub")


async def test_read_escape_raises_outside_workspace(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    with pytest.raises(OutsideWorkspace):
        await _ws(ws).read("../secret.txt")


# --- write ---


async def test_write_creates_parents_and_returns_count(tmp_path: Path):
    written = await _ws(tmp_path).write("nested/dir/out.txt", "abcd")
    assert written == 4
    assert (tmp_path / "nested" / "dir" / "out.txt").read_text(encoding="utf-8") == "abcd"


async def test_write_escape_raises_outside_workspace(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    with pytest.raises(OutsideWorkspace):
        await _ws(ws).write("../evil.txt", "x")


# --- list ---


async def test_list_marks_dirs_and_files(tmp_path: Path):
    (tmp_path / "f.txt").write_text("x", encoding="utf-8")
    (tmp_path / "d").mkdir()
    entries = {e.path: e.is_dir for e in await _ws(tmp_path).list(".", "*")}
    assert entries.get("f.txt") is False
    assert entries.get("d") is True


async def test_list_on_file_raises_not_a_directory(tmp_path: Path):
    (tmp_path / "f.txt").write_text("x", encoding="utf-8")
    with pytest.raises(NotADirectory):
        await _ws(tmp_path).list("f.txt", "*")


# --- replace ---


async def test_replace_single_reports_count_and_line(tmp_path: Path):
    (tmp_path / "f.txt").write_text("l1\nFOO\nl3\n", encoding="utf-8")
    outcome = await _ws(tmp_path).replace("f.txt", "FOO", "BAR", all_=False)
    assert outcome.count == 1
    assert outcome.first_line == 2
    assert (tmp_path / "f.txt").read_text(encoding="utf-8") == "l1\nBAR\nl3\n"


async def test_replace_all_counts_every_span(tmp_path: Path):
    (tmp_path / "f.txt").write_text("aXaXa", encoding="utf-8")
    outcome = await _ws(tmp_path).replace("f.txt", "a", "b", all_=True)
    assert outcome.count == 3
    assert outcome.first_line is None
    assert (tmp_path / "f.txt").read_text(encoding="utf-8") == "bXbXb"


async def test_replace_no_match_raises(tmp_path: Path):
    (tmp_path / "f.txt").write_text("hello", encoding="utf-8")
    with pytest.raises(NoMatch):
        await _ws(tmp_path).replace("f.txt", "zzz", "q", all_=False)


async def test_replace_ambiguous_raises_with_count(tmp_path: Path):
    (tmp_path / "f.txt").write_text("aXaXa", encoding="utf-8")
    with pytest.raises(AmbiguousMatch) as exc:
        await _ws(tmp_path).replace("f.txt", "a", "b", all_=False)
    assert exc.value.count == 3


async def test_replace_binary_raises_not_utf8(tmp_path: Path):
    (tmp_path / "blob.bin").write_bytes(b"\xff\xfe\x00\x01")
    with pytest.raises(NotUTF8):
        await _ws(tmp_path).replace("blob.bin", "x", "y", all_=False)


async def test_replace_missing_raises_path_not_found(tmp_path: Path):
    with pytest.raises(PathNotFound):
        await _ws(tmp_path).replace("nope.txt", "x", "y", all_=False)


# --- execute (the cwd fix) ---


async def test_execute_runs_in_workspace_so_code_sees_files(tmp_path: Path):
    """Code runs with cwd = workspace root, so a relative open() finds the file
    the file tools wrote — the bug where code_execute ran in a throwaway tempdir."""
    (tmp_path / "data.txt").write_text("hello-from-workspace", encoding="utf-8")
    result = await _ws(tmp_path).execute(
        ExecutionRequest(
            code="print(open('data.txt').read())",
            language="python",
            timeout_seconds=15,
        )
    )
    assert result.success
    assert "hello-from-workspace" in result.stdout


# --- dirty tracking (drives the post-turn auto-snapshot, 决策⑥) ---


async def test_starts_clean(tmp_path: Path):
    assert _ws(tmp_path).dirty is False


async def test_read_only_ops_do_not_dirty(tmp_path: Path):
    (tmp_path / "f.txt").write_text("hello", encoding="utf-8")
    ws = _ws(tmp_path)
    await ws.read("f.txt")
    await ws.list(".", "*")
    await ws.grep(GrepQuery(pattern="hello"))
    assert ws.dirty is False


async def test_write_marks_dirty(tmp_path: Path):
    ws = _ws(tmp_path)
    await ws.write("out.txt", "x")
    assert ws.dirty is True


async def test_replace_marks_dirty(tmp_path: Path):
    (tmp_path / "f.txt").write_text("FOO", encoding="utf-8")
    ws = _ws(tmp_path)
    await ws.replace("f.txt", "FOO", "BAR", all_=False)
    assert ws.dirty is True


async def test_failed_write_does_not_dirty(tmp_path: Path):
    ws_root = tmp_path / "ws"
    ws_root.mkdir()
    ws = _ws(ws_root)
    with pytest.raises(OutsideWorkspace):
        await ws.write("../escape.txt", "x")
    assert ws.dirty is False


async def test_execute_marks_dirty(tmp_path: Path):
    ws = _ws(tmp_path)
    await ws.execute(
        ExecutionRequest(code="print('hi')", language="python", timeout_seconds=15)
    )
    assert ws.dirty is True


# --- binary I/O (file upload / download) ---


async def test_write_then_read_bytes_roundtrip(tmp_path: Path):
    blob = bytes(range(256))  # non-UTF-8 bytes
    ws = _ws(tmp_path)
    written = await ws.write_bytes("nested/blob.bin", blob)
    assert written == 256
    assert await ws.read_bytes("nested/blob.bin") == blob


async def test_write_bytes_marks_dirty(tmp_path: Path):
    ws = _ws(tmp_path)
    await ws.write_bytes("f.bin", b"\x00\x01")
    assert ws.dirty is True


async def test_read_bytes_missing_raises_path_not_found(tmp_path: Path):
    with pytest.raises(PathNotFound):
        await _ws(tmp_path).read_bytes("nope.bin")


async def test_read_bytes_directory_raises_not_a_file(tmp_path: Path):
    (tmp_path / "sub").mkdir()
    with pytest.raises(NotAFile):
        await _ws(tmp_path).read_bytes("sub")


async def test_read_bytes_escape_raises_outside_workspace(tmp_path: Path):
    ws_root = tmp_path / "ws"
    ws_root.mkdir()
    (tmp_path / "secret.bin").write_bytes(b"x")
    with pytest.raises(OutsideWorkspace):
        await _ws(ws_root).read_bytes("../secret.bin")


async def test_write_bytes_escape_raises_outside_workspace(tmp_path: Path):
    ws_root = tmp_path / "ws"
    ws_root.mkdir()
    with pytest.raises(OutsideWorkspace):
        await _ws(ws_root).write_bytes("../evil.bin", b"x")
