"""Tests for ``ServerWorkspace.index_files`` — the @ mention flat file index.

Filesystem-backed but hermetic: each test builds a throwaway tree under
``tmp_path``. This is the cloud counterpart to the desktop ``fsApi.listFiles``
that indexes local roots (文件中枢统一 F4), so it must behave the same: a flat,
files-only, POSIX path list with noise dirs pruned and a hard cap.
"""

from pathlib import Path

from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ws(root: Path) -> ServerWorkspace:
    return ServerWorkspace(root=root, sandbox=SubprocessSandbox())


def _seed(root: Path) -> None:
    (root / "README.md").write_text("r", encoding="utf-8")
    src = root / "src"
    src.mkdir()
    (src / "app.ts").write_text("a", encoding="utf-8")
    (src / "util.ts").write_text("u", encoding="utf-8")
    # Noise dirs that must be pruned (mirrors local indexing).
    nm = root / "node_modules" / "dep"
    nm.mkdir(parents=True)
    (nm / "index.js").write_text("x", encoding="utf-8")
    git = root / ".git"
    git.mkdir()
    (git / "config").write_text("g", encoding="utf-8")


async def test_index_lists_files_only_with_posix_paths(tmp_path: Path):
    _seed(tmp_path)
    paths, truncated = await _ws(tmp_path).index_files()
    # Files only (no dir entries), forward-slash separators, sorted.
    assert paths == ["README.md", "src/app.ts", "src/util.ts"]
    assert truncated is False


async def test_index_prunes_ignored_dirs(tmp_path: Path):
    _seed(tmp_path)
    paths, _ = await _ws(tmp_path).index_files()
    joined = "\n".join(paths)
    assert "node_modules" not in joined
    assert ".git" not in joined


async def test_index_caps_and_flags_truncation(tmp_path: Path):
    for i in range(5):
        (tmp_path / f"f{i}.txt").write_text("x", encoding="utf-8")
    paths, truncated = await _ws(tmp_path).index_files(cap=3)
    assert len(paths) == 3
    assert truncated is True


async def test_index_empty_workspace(tmp_path: Path):
    paths, truncated = await _ws(tmp_path).index_files()
    assert paths == []
    assert truncated is False
