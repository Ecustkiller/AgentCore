"""Code intelligence tool: symbols, references, imports and diagnostics."""

from pathlib import Path

from agentcore.tools.builtin.code_intel import CodeIntelTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


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
    (root / "src" / "pkg").mkdir()
    (root / "src" / "pkg" / "__init__.py").write_text(
        "from .worker import run\n",
        encoding="utf-8",
    )
    (root / "src" / "pkg" / "worker.py").write_text(
        "def run():\n    return 1\n",
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
        "from . import util\n\ndef add_again():\n    return 1\n",
        encoding="utf-8",
    )
    (root / "src" / "unresolved.py").write_text(
        "value = 1\n\nfrom .missing import absent\n",
        encoding="utf-8",
    )
    (root / "tests" / "test_app.py").write_text(
        "from src.app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
        encoding="utf-8",
    )
    (root / "broken.py").write_text("def nope(:\n", encoding="utf-8")
    (root / "web.ts").write_text(
        'import "./lib"\nexport function greet(name: string) { return name; }\n',
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
    assert "src/util.py:2: method double" in methods.output


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
    ctx.landed_artifact_kinds["src/app.py"] = "prose"
    affected_from_turn = await tool.execute(
        {"action": "affected_tests"},
        ctx,
    )
    diagnostics = await tool.execute({"action": "diagnostics"}, ctx)
    typescript = await tool.execute(
        {"action": "symbols", "query": "greet"},
        ctx,
    )

    assert "src/app.py:1 -> .util" in imports.output
    assert "tests/test_app.py" in affected.output
    assert "tests/test_app.py" in affected_from_turn.output
    assert "broken.py" in diagnostics.output
    assert "src/unresolved.py:3: unresolved relative import .missing" in diagnostics.output
    assert "src/other.py" not in diagnostics.output
    assert "src/pkg/__init__.py" not in diagnostics.output
    assert "web.ts" in typescript.output
