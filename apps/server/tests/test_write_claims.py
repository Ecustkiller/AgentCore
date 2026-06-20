"""Tests for the intra-batch write-conflict guard (并行写隔离·硬约束).

Two layers: the pure :class:`WriteCoordinator` ownership rules, and the
``FileWriteTool`` end-to-end behaviour when a coordinator is wired onto the context
(concurrent sibling refused; dependency overwrite allowed; no-coordinator path inert).
"""

from pathlib import Path

from agentcore.tools.builtin.file_ops import FileWriteTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace
from agentcore.workspace.write_claims import WriteCoordinator


def _ctx(
    workspace: Path,
    *,
    run_id: str = "s",
    coordinator: WriteCoordinator | None = None,
    ancestors: frozenset[str] = frozenset(),
) -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id=run_id,
        agent_id="a",
        backend=ServerWorkspace(root=workspace, sandbox=SubprocessSandbox()),
        user_id="u",
        write_coordinator=coordinator,
        write_ancestors=ancestors,
    )


# --- WriteCoordinator unit rules ---


def test_first_claim_granted():
    c = WriteCoordinator()
    assert c.claim("report.md", "a", frozenset()) is None


def test_concurrent_sibling_conflicts():
    c = WriteCoordinator()
    assert c.claim("report.md", "a", frozenset()) is None
    # b has no dependency on a → blocked, told who owns it.
    assert c.claim("report.md", "b", frozenset()) == "a"


def test_same_run_may_rewrite_its_own_file():
    c = WriteCoordinator()
    assert c.claim("report.md", "a", frozenset()) is None
    # A contract retry re-writes the same path under the same run → allowed.
    assert c.claim("report.md", "a", frozenset()) is None


def test_descendant_may_overwrite_ancestor_file():
    c = WriteCoordinator()
    assert c.claim("report.md", "upstream", frozenset()) is None
    # d depends on upstream → consolidating its product is intended, not a clobber.
    assert c.claim("report.md", "d", frozenset({"upstream"})) is None
    # ownership transferred to d: a fresh unrelated sibling now conflicts with d.
    assert c.claim("report.md", "e", frozenset()) == "d"


def test_paths_normalized_to_one_owner():
    c = WriteCoordinator()
    assert c.claim("out/report.md", "a", frozenset()) is None
    # ./out/report.md and out//report.md are the same file → same conflict.
    assert c.claim("./out/report.md", "b", frozenset()) == "a"
    assert c.claim("out//report.md", "b", frozenset()) == "a"


def test_release_frees_a_failed_write():
    c = WriteCoordinator()
    assert c.claim("report.md", "a", frozenset()) is None
    c.release("report.md", "a")
    # a never really wrote it (write failed) → b is free to take the name.
    assert c.claim("report.md", "b", frozenset()) is None


def test_release_only_affects_the_owner():
    c = WriteCoordinator()
    assert c.claim("report.md", "a", frozenset()) is None
    # b doesn't own it; its release is a no-op (can't free a's claim).
    c.release("report.md", "b")
    assert c.claim("report.md", "b", frozenset()) == "a"


# --- FileWriteTool end-to-end ---


async def test_concurrent_sibling_write_is_refused_and_does_not_clobber(tmp_path: Path):
    coordinator = WriteCoordinator()
    a = await FileWriteTool().execute(
        {"path": "report.md", "content": "from-A"},
        _ctx(tmp_path, run_id="a", coordinator=coordinator),
    )
    assert a.success is True

    b = await FileWriteTool().execute(
        {"path": "report.md", "content": "from-B"},
        _ctx(tmp_path, run_id="b", coordinator=coordinator),
    )
    assert b.success is False
    assert "写入冲突" in b.error
    assert "report-1.md" in b.error  # the concrete rename hint
    # A's deliverable survives — B never overwrote it.
    assert (tmp_path / "report.md").read_text(encoding="utf-8") == "from-A"


async def test_dependency_overwrite_is_allowed(tmp_path: Path):
    coordinator = WriteCoordinator()
    await FileWriteTool().execute(
        {"path": "report.md", "content": "draft"},
        _ctx(tmp_path, run_id="up", coordinator=coordinator),
    )
    # downstream depends on "up" → may consolidate (overwrite) its file.
    d = await FileWriteTool().execute(
        {"path": "report.md", "content": "final"},
        _ctx(tmp_path, run_id="down", coordinator=coordinator, ancestors=frozenset({"up"})),
    )
    assert d.success is True
    assert (tmp_path / "report.md").read_text(encoding="utf-8") == "final"


async def test_no_coordinator_means_no_guard(tmp_path: Path):
    # The CEO / tests path: without a coordinator, file_write is unguarded (two writes
    # to the same path just overwrite, last-writer-wins — the pre-existing behaviour).
    first = await FileWriteTool().execute(
        {"path": "report.md", "content": "one"}, _ctx(tmp_path, run_id="a")
    )
    second = await FileWriteTool().execute(
        {"path": "report.md", "content": "two"}, _ctx(tmp_path, run_id="b")
    )
    assert first.success is True
    assert second.success is True
    assert (tmp_path / "report.md").read_text(encoding="utf-8") == "two"
