"""Code intelligence tool: symbols, references, imports and diagnostics."""

import asyncio
from pathlib import Path

import pytest

from agentcore.tools.builtin.code_intel import (
    CodeIntelTool,
    reset_persistent_index_cache,
)
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


@pytest.fixture(autouse=True)
def _clear_persistent_index():
    reset_persistent_index_cache()
    yield
    reset_persistent_index_cache()


def _ctx(root: Path) -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=ServerWorkspace(root=root, sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _seed(root: Path) -> None:
    (root / "src").mkdir()
    (root / "tests").mkdir()
    (root / "tests" / "ui.test.ts").write_text(
        'import { ui } from "@/ui"\n',
        encoding="utf-8",
    )
    (root / "src" / "pkg").mkdir()
    (root / "src" / "pkg" / "__init__.py").write_text(
        "from .worker import run\n",
        encoding="utf-8",
    )
    (root / "src" / "pkg" / "worker.py").write_text(
        "def run():\n    return 1\n",
        encoding="utf-8",
    )
    (root / "src" / "ui.ts").write_text(
        'import value from "@/lib"\nexport const ui = value\n',
        encoding="utf-8",
    )
    (root / "src" / "util.py").write_text(
        "class Calc:\n    def double(self, value):\n        return value * 2\n",
        encoding="utf-8",
    )
    (root / "src" / "app.py").write_text(
        "from .util import Calc\n\ndef add(a, b):\n    return a + b\n",
        encoding="utf-8",
    )
    (root / "src" / "other.py").write_text(
        "from . import util\n\ndef add_again():\n    return util.Calc()\n",
        encoding="utf-8",
    )
    (root / "src" / "semantic.py").write_text(
        "def broken():\n    return missing_name\n",
        encoding="utf-8",
    )
    (root / "src" / "unresolved.py").write_text(
        "value = 1\n\nfrom .missing import absent\n",
        encoding="utf-8",
    )
    (root / "src" / "missing_absolute.py").write_text(
        "from src.not_here import value\n",
        encoding="utf-8",
    )
    (root / "tests" / "test_app.py").write_text(
        "from src.app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
        encoding="utf-8",
    )
    (root / "broken.py").write_text("def nope(:\n", encoding="utf-8")
    (root / "web.ts").write_text(
        'import "./lib"\n'
        '// import "./ghost"\n'
        '// function phantom() {}\n'
        'export function greet(name: string) { return "{"; }\n',
        encoding="utf-8",
    )
    (root / "lib.ts").write_text("export const value = 1;\n", encoding="utf-8")


async def test_code_intel_symbols_and_references(tmp_path: Path):
    _seed(tmp_path)
    tool = CodeIntelTool()
    symbols = await tool.execute(
        {"action": "symbols", "query": "add"},
        _ctx(tmp_path),
    )
    references = await tool.execute(
        {"action": "references", "query": "add"},
        _ctx(tmp_path),
    )
    scoped_references = await tool.execute(
        {"action": "references", "query": "add", "path": "src"},
        _ctx(tmp_path),
    )
    methods = await tool.execute(
        {"action": "symbols", "query": "double", "path": "src/util.py"},
        _ctx(tmp_path),
    )

    assert symbols.success is True
    assert "src/app.py:3: function add" in symbols.output
    assert references.success is True
    assert "tests/test_app.py" in references.output
    assert "tests/test_app.py" not in scoped_references.output
    assert "src/util.py:2:" in methods.output
    assert "double" in methods.output


async def test_references_do_not_depend_on_parser_budget(tmp_path, monkeypatch):
    from agentcore.tools.builtin import code_intel as module

    (tmp_path / "a.py").write_text("def first():\n    return 1\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("def second():\n    return 2\n", encoding="utf-8")
    (tmp_path / "z.py").write_text("from a import first\nfirst()\n", encoding="utf-8")
    monkeypatch.setattr(module, "_INDEX_FILE_CAP", 1)

    result = await CodeIntelTool().execute(
        {"action": "references", "query": "first"},
        _ctx(tmp_path),
    )

    assert "a.py:1: def first" in result.output
    assert "z.py:1: from a import first" in result.output
    assert result.metadata["source"] == "grep"


async def test_imports_do_not_depend_on_parser_budget(tmp_path, monkeypatch):
    from agentcore.tools.builtin import code_intel as module

    (tmp_path / "a.py").write_text("value = 1\n", encoding="utf-8")
    (tmp_path / "z.py").write_text("from .a import value\n", encoding="utf-8")
    monkeypatch.setattr(module, "_INDEX_FILE_CAP", 1)

    result = await CodeIntelTool().execute(
        {"action": "imports", "path": "z.py"},
        _ctx(tmp_path),
    )

    assert "z.py:1 -> .a" in result.output
    assert "z.py <- " not in result.output
    assert result.metadata["source"] == "targeted"


async def test_targeted_imports_finds_reverse_importer(tmp_path):
    (tmp_path / "a.py").write_text("value = 1\n", encoding="utf-8")
    (tmp_path / "z.py").write_text("from a import value\n", encoding="utf-8")

    result = await CodeIntelTool().execute(
        {"action": "imports", "path": "a.py"},
        _ctx(tmp_path),
    )

    assert "a.py <- z.py" in result.output
    assert result.metadata["source"] == "targeted"


async def test_targeted_imports_tracks_from_package_submodule(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "__init__.py").write_text("", encoding="utf-8")
    (tmp_path / "pkg" / "worker.py").write_text("value = 1\n", encoding="utf-8")
    (tmp_path / "consumer.py").write_text(
        "from pkg import worker\n",
        encoding="utf-8",
    )

    result = await CodeIntelTool().execute(
        {"action": "imports", "path": "pkg/worker.py"},
        _ctx(tmp_path),
    )

    assert "pkg/worker.py <- consumer.py" in result.output


async def test_affected_tests_prioritizes_test_directory(tmp_path, monkeypatch):
    from agentcore.tools.builtin import code_intel as module

    (tmp_path / "a.py").write_text("value = 1\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("from a import value\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_integration.py").write_text(
        "from b import value\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "_INDEX_FILE_CAP", 1)
    monkeypatch.setattr(module, "_TEST_INDEX_FILE_CAP", 1)

    result = await CodeIntelTool().execute(
        {"action": "affected_tests", "paths": ["b.py"]},
        _ctx(tmp_path),
    )

    assert "tests/test_integration.py" in result.output


async def test_code_intel_imports_affected_tests_and_diagnostics(tmp_path: Path):
    _seed(tmp_path)
    tool = CodeIntelTool()
    ctx = _ctx(tmp_path)
    imports = await tool.execute(
        {"action": "imports", "path": "src/app.py"},
        ctx,
    )
    affected = await tool.execute(
        {"action": "affected_tests", "paths": ["src/util.py"]},
        ctx,
    )
    ts_affected = await tool.execute(
        {"action": "affected_tests", "paths": ["lib.ts"]},
        ctx,
    )
    ctx.landed_artifact_kinds["src/app.py"] = "prose"
    affected_from_turn = await tool.execute(
        {"action": "affected_tests"},
        ctx,
    )
    changed_test = await tool.execute(
        {"action": "affected_tests", "paths": ["tests/test_app.py"]},
        ctx,
    )
    diagnostics = await tool.execute({"action": "diagnostics"}, ctx)
    typescript = await tool.execute(
        {"action": "symbols", "query": "greet"},
        ctx,
    )
    phantom = await tool.execute(
        {"action": "symbols", "query": "phantom"},
        ctx,
    )

    assert "src/app.py:1 -> .util" in imports.output
    assert "tests/test_app.py" in affected.output
    assert "tests/ui.test.ts" in ts_affected.output
    assert "tests/test_app.py" in affected_from_turn.output
    assert "tests/test_app.py" in changed_test.output
    assert "broken.py" in diagnostics.output
    assert "src/semantic.py:2: undefined name 'missing_name'" in diagnostics.output
    assert "src/unresolved.py:3: unresolved relative import .missing" in diagnostics.output
    assert "src/missing_absolute.py:1: unresolved local import src.not_here" in (
        diagnostics.output
    )
    assert "src/other.py" not in diagnostics.output
    assert "unresolved relative import .worker" not in diagnostics.output
    assert "web.ts" in typescript.output
    assert "phantom" not in phantom.output
    assert "ghost" not in diagnostics.output
    assert "unbalanced braces" not in diagnostics.output


async def test_code_intel_index_is_single_flight(tmp_path: Path, monkeypatch):
    _seed(tmp_path)
    ctx = _ctx(tmp_path)
    original = ctx.backend.index_files
    calls = 0

    async def counted(*args, **kwargs):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.02)
        return await original(*args, **kwargs)

    monkeypatch.setattr(ctx.backend, "index_files", counted)
    tool = CodeIntelTool()
    first, second = await asyncio.gather(
        tool.execute({"action": "symbols"}, ctx),
        tool.execute({"action": "diagnostics"}, ctx),
    )

    assert first.success is True
    assert second.success is True
    assert calls == 1


async def test_symbol_query_avoids_full_index(tmp_path, monkeypatch):
    _seed(tmp_path)
    ctx = _ctx(tmp_path)

    async def unexpected(*args, **kwargs):
        raise AssertionError("symbol query should use grep first")

    monkeypatch.setattr(ctx.backend, "index_files", unexpected)
    result = await CodeIntelTool().execute(
        {"action": "symbols", "query": "greet"},
        ctx,
    )

    assert "web.ts" in result.output
    assert result.metadata["source"] == "grep"


async def test_full_index_is_reused_across_turn_backends(tmp_path):
    _seed(tmp_path)
    first = await CodeIntelTool().execute({"action": "symbols"}, _ctx(tmp_path))
    second_ctx = _ctx(tmp_path)
    original_read = second_ctx.backend.read
    read_paths: list[str] = []

    async def counted_read(path: str) -> str:
        read_paths.append(path)
        return await original_read(path)

    second_ctx.backend.read = counted_read  # type: ignore[method-assign]
    second = await CodeIntelTool().execute({"action": "symbols"}, second_ctx)

    assert first.success is True
    assert second.success is True
    assert second.metadata["persistent_hits"] > 0
    assert read_paths == []


async def test_incremental_index_reparses_only_changed_file(tmp_path):
    _seed(tmp_path)
    await CodeIntelTool().execute({"action": "symbols"}, _ctx(tmp_path))
    (tmp_path / "src" / "util.py").write_text(
        "class Calc:\n    def triple(self, value):\n        return value * 3\n",
        encoding="utf-8",
    )
    second_ctx = _ctx(tmp_path)
    original_read = second_ctx.backend.read
    read_paths: list[str] = []

    async def counted_read(path: str) -> str:
        read_paths.append(path)
        return await original_read(path)

    second_ctx.backend.read = counted_read  # type: ignore[method-assign]
    second = await CodeIntelTool().execute({"action": "symbols"}, second_ctx)

    assert read_paths == ["src/util.py"]
    assert "method triple" in second.output
    assert second.metadata["persistent_hits"] > 0


async def test_scoped_index_survives_parser_budget_truncation(tmp_path, monkeypatch):
    from agentcore.tools.builtin import code_intel as module

    (tmp_path / "a.py").write_text("def first():\n    pass\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("def second():\n    pass\n", encoding="utf-8")
    (tmp_path / "z.py").write_text("def deep_target():\n    pass\n", encoding="utf-8")
    monkeypatch.setattr(module, "_INDEX_FILE_CAP", 2)
    tool = CodeIntelTool()

    global_index = await tool.execute(
        {"action": "symbols"},
        _ctx(tmp_path),
    )
    scoped_index = await tool.execute(
        {"action": "symbols", "path": "z.py"},
        _ctx(tmp_path),
    )

    assert "deep_target" not in global_index.output
    assert "z.py:1: function deep_target" in scoped_index.output


async def test_symbol_grep_completes_partial_query_without_index(tmp_path):
    (tmp_path / "a.py").write_text("def first_helper():\n    pass\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("def second():\n    pass\n", encoding="utf-8")
    (tmp_path / "z.py").write_text("def first_deep():\n    pass\n", encoding="utf-8")

    result = await CodeIntelTool().execute(
        {"action": "symbols", "query": "first"},
        _ctx(tmp_path),
    )

    assert "a.py:1: function first_helper" in result.output
    assert "z.py:1: function first_deep" in result.output


async def test_scoped_index_walks_past_flat_list_cap(tmp_path, monkeypatch):
    from agentcore.tools.builtin import code_intel as module

    (tmp_path / "a.py").write_text("def first():\n    pass\n", encoding="utf-8")
    (tmp_path / "nested").mkdir()
    (tmp_path / "nested" / "z.py").write_text(
        "def beyond_cap():\n    pass\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "_INDEX_LIST_CAP", 1)
    tool = CodeIntelTool()

    scoped = await tool.execute(
        {"action": "symbols", "path": "nested"},
        _ctx(tmp_path),
    )

    assert "nested/z.py:1: function beyond_cap" in scoped.output
