"""Tests for code_search indexing and tool."""

from pathlib import Path

import pytest

from agentcore.tools.builtin.code_search import CodeSearchTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.indexing.chunker import chunk_file, detect_language
from agentcore.workspace.indexing.manager import IndexManager
from agentcore.workspace.server import ServerWorkspace


@pytest.fixture
def sample_py(tmp_path: Path) -> Path:
    src = tmp_path / "pkg" / "sample.py"
    src.parent.mkdir(parents=True)
    src.write_text(
        '''"""Sample module."""

class ApprovalGate:
    """Gate tool approvals."""

    async def check(self, tool_name: str) -> bool:
        """Check whether a tool may run."""
        return True


def helper_function():
  return "noop"
''',
        encoding="utf-8",
    )
    return tmp_path


def test_detect_language_python():
    assert detect_language("apps/foo/bar.py") == "python"
    assert detect_language("component.tsx") == "tsx"


@pytest.mark.asyncio
async def test_chunk_file_python_symbols():
    content = '''class Foo:
    def bar(self):
        pass

def baz():
    return 1
'''
    chunks = await chunk_file("mod.py", content, "python")
    assert chunks
    symbols = {c.symbol for c in chunks if c.symbol}
    assert "Foo" in symbols or "bar" in symbols or "baz" in symbols


@pytest.mark.asyncio
async def test_index_manager_build_and_search(sample_py: Path):
    ws = ServerWorkspace(root=sample_py, sandbox=SubprocessSandbox())
    manager = IndexManager(str(sample_py))

    updated = await manager.ensure_index(ws)
    assert updated is True

    result = await manager.search("approval gate check", max_results=5)
    assert result.chunks
    assert result.scores
    assert len(result.chunks) == len(result.scores)
    paths = {c.path for c in result.chunks}
    assert any("sample.py" in p for p in paths)

    db_path = sample_py / ".agentcore" / "index" / "code_search.db"
    assert db_path.is_file()


@pytest.mark.asyncio
async def test_code_search_tool_end_to_end(sample_py: Path):
    ws = ServerWorkspace(root=sample_py, sandbox=SubprocessSandbox())
    tool = CodeSearchTool()
    ctx = ToolContext(
        execution_id="e1",
        run_id="r1",
        agent_id="a1",
        backend=ws,
        user_id="u1",
    )
    result = await tool.execute({"query": "ApprovalGate check"}, ctx)
    assert result.success
    assert "sample.py" in result.output
    assert "score=" in result.output


@pytest.mark.asyncio
async def test_ensure_code_index_is_incremental(sample_py: Path):
    ws = ServerWorkspace(root=sample_py, sandbox=SubprocessSandbox())
    manager = IndexManager(str(sample_py))

    assert await manager.ensure_index(ws) is True
    assert await manager.ensure_index(ws) is False

    py_file = sample_py / "pkg" / "sample.py"
    py_file.write_text(py_file.read_text() + "\n# touch\n", encoding="utf-8")
    assert await manager.ensure_index(ws) is True


@pytest.mark.asyncio
async def test_code_search_requires_query(sample_py: Path):
    ws = ServerWorkspace(root=sample_py, sandbox=SubprocessSandbox())
    tool = CodeSearchTool()
    ctx = ToolContext(
        execution_id="e1",
        run_id="r1",
        agent_id="a1",
        backend=ws,
        user_id="u1",
    )
    result = await tool.execute({"query": ""}, ctx)
    assert not result.success
    assert "query" in (result.error or "").lower()
