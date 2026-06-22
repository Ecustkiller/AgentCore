"""Tests for the grep tool (workspace content search) and its path guard.

Filesystem-backed but hermetic: every test builds a throwaway tree under
``tmp_path`` and points the tool's workspace at it, so nothing escapes the
sandbox and no real repo files are read.
"""

from pathlib import Path

from agentcore.tools.builtin.grep import GrepTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace._paths import normalize_glob, resolve_safe_path
from agentcore.workspace.server import ServerWorkspace


def _ctx(workspace: Path) -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=workspace, sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _seed(root: Path) -> None:
    """A small, representative workspace tree."""
    (root / "app.py").write_text(
        "def add(a, b):\n    return a + b  # TODO: validate\n", encoding="utf-8"
    )
    (root / "util.py").write_text("VALUE = 42\nprint('todo later')\n", encoding="utf-8")
    (root / "notes.md").write_text("# Notes\nSee TODO in app.py\n", encoding="utf-8")
    sub = root / "src"
    sub.mkdir()
    (sub / "main.ts").write_text("const x = 1; // TODO ts\n", encoding="utf-8")
    # noise dir that must be pruned
    nm = root / "node_modules" / "dep"
    nm.mkdir(parents=True)
    (nm / "index.js").write_text("// TODO inside node_modules\n", encoding="utf-8")


# --- validation / failure paths ---


async def test_grep_requires_pattern(tmp_path: Path):
    result = await GrepTool().execute({}, _ctx(tmp_path))
    assert result.success is False
    assert "pattern" in result.error


async def test_grep_rejects_invalid_regex(tmp_path: Path):
    result = await GrepTool().execute({"pattern": "("}, _ctx(tmp_path))
    assert result.success is False
    assert "正则" in result.error


async def test_grep_rejects_path_outside_workspace(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    result = await GrepTool().execute({"pattern": "x", "path": "../"}, _ctx(ws))
    assert result.success is False
    assert "超出了工作区范围" in result.error


async def test_grep_rejects_missing_path(tmp_path: Path):
    result = await GrepTool().execute({"pattern": "x", "path": "nope.txt"}, _ctx(tmp_path))
    assert result.success is False
    assert "不存在" in result.error


# --- core search behavior ---


async def test_grep_finds_matches_with_path_and_lineno(tmp_path: Path):
    _seed(tmp_path)
    result = await GrepTool().execute({"pattern": "TODO"}, _ctx(tmp_path))
    assert result.success is True
    # ripgrep-style "rel:lineno: text" with forward slashes, sorted by file
    assert "app.py:2: return a + b  # TODO: validate" in result.output
    assert "src/main.ts:1: const x = 1; // TODO ts" in result.output
    # case-sensitive by default: 'todo later' must NOT match 'TODO'
    assert "util.py" not in result.output


async def test_grep_prunes_noise_dirs(tmp_path: Path):
    _seed(tmp_path)
    result = await GrepTool().execute({"pattern": "TODO"}, _ctx(tmp_path))
    assert "node_modules" not in result.output


async def test_grep_glob_filters_by_name(tmp_path: Path):
    _seed(tmp_path)
    result = await GrepTool().execute({"pattern": "TODO", "glob": "*.py"}, _ctx(tmp_path))
    assert "app.py" in result.output
    assert "main.ts" not in result.output
    assert "notes.md" not in result.output


async def test_grep_glob_strips_recursive_prefix(tmp_path: Path):
    _seed(tmp_path)
    result = await GrepTool().execute({"pattern": "TODO", "glob": "**/*.ts"}, _ctx(tmp_path))
    assert "src/main.ts" in result.output
    assert "app.py" not in result.output


async def test_grep_case_insensitive(tmp_path: Path):
    _seed(tmp_path)
    result = await GrepTool().execute({"pattern": "todo", "case_insensitive": True}, _ctx(tmp_path))
    assert "util.py:2" in result.output  # 'todo later'
    assert "app.py:2" in result.output  # 'TODO: validate'


async def test_grep_scopes_to_subdirectory(tmp_path: Path):
    _seed(tmp_path)
    result = await GrepTool().execute({"pattern": "TODO", "path": "src"}, _ctx(tmp_path))
    assert "src/main.ts" in result.output
    assert "app.py" not in result.output


async def test_grep_path_can_be_single_file(tmp_path: Path):
    """``path`` may name a single file (rg PATTERN FILE) — scan just that file."""
    _seed(tmp_path)
    result = await GrepTool().execute({"pattern": "TODO", "path": "app.py"}, _ctx(tmp_path))
    assert result.success is True
    assert "app.py:2: return a + b  # TODO: validate" in result.output
    # scoped to the one file — sibling matches must not leak in
    assert "src/main.ts" not in result.output
    assert "notes.md" not in result.output


async def test_grep_single_file_path_ignores_glob(tmp_path: Path):
    """When ``path`` is a file, ``glob`` is moot — the file is already pinpointed."""
    _seed(tmp_path)
    result = await GrepTool().execute(
        {"pattern": "TODO", "path": "app.py", "glob": "*.ts"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert "app.py:2" in result.output


async def test_grep_files_only_lists_files_with_counts(tmp_path: Path):
    _seed(tmp_path)
    result = await GrepTool().execute({"pattern": "TODO", "files_only": True}, _ctx(tmp_path))
    assert result.success is True
    assert "个文件匹配" in result.output
    assert "app.py: 1" in result.output
    # files_only must not emit individual line bodies
    assert "return a + b" not in result.output


async def test_grep_no_matches(tmp_path: Path):
    _seed(tmp_path)
    result = await GrepTool().execute({"pattern": "zzz_nope"}, _ctx(tmp_path))
    assert result.success is True
    assert "没有匹配" in result.output
    assert result.metadata["match_count"] == 0


async def test_grep_skips_binary_files(tmp_path: Path):
    (tmp_path / "blob.bin").write_bytes(b"\xff\xfe\x00\x01 needle here \x00")
    (tmp_path / "ok.txt").write_text("needle here\n", encoding="utf-8")
    result = await GrepTool().execute({"pattern": "needle"}, _ctx(tmp_path))
    assert "ok.txt:1" in result.output
    assert "blob.bin" not in result.output


async def test_grep_truncates_at_max_results(tmp_path: Path):
    (tmp_path / "many.txt").write_text("hit\n" * 10, encoding="utf-8")
    result = await GrepTool().execute({"pattern": "hit", "max_results": 3}, _ctx(tmp_path))
    assert "[结果已截断" in result.output
    # 3 matching lines + summary header + truncation note
    body_lines = [ln for ln in result.output.splitlines() if ln.startswith("many.txt:")]
    assert len(body_lines) == 3


# --- normalize_glob ---


def test_normalize_glob_reduces_to_name_pattern():
    assert normalize_glob("*.py") == "*.py"
    assert normalize_glob("**/*.py") == "*.py"
    assert normalize_glob("src/**/*.ts") == "*.ts"
    assert normalize_glob("") is None
    assert normalize_glob("   ") is None


# --- resolve_safe_path (workspace boundary) ---


def test_resolve_safe_path_allows_root_and_children(tmp_path: Path):
    assert resolve_safe_path(tmp_path, ".") == tmp_path.resolve()
    child = resolve_safe_path(tmp_path, "a/b.txt")
    assert child is not None
    assert child == (tmp_path / "a" / "b.txt").resolve()


def test_resolve_safe_path_blocks_parent_escape(tmp_path: Path):
    assert resolve_safe_path(tmp_path, "../secret") is None
    assert resolve_safe_path(tmp_path, "../../etc/passwd") is None


def test_resolve_safe_path_blocks_prefix_sibling(tmp_path: Path):
    """A sibling dir that shares the workspace name as a string prefix must not
    be reachable — the bug a naive ``startswith`` check would let through."""
    ws = tmp_path / "ws"
    ws.mkdir()
    (tmp_path / "ws-evil").mkdir()
    assert resolve_safe_path(ws, "../ws-evil") is None
    assert resolve_safe_path(ws, "../ws-evil/loot.txt") is None
