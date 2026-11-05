"""Structured multi-file patch behavior and rollback."""

from pathlib import Path

from agentcore.tools.builtin.file_ops import ApplyPatchTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.protocol import WorkspaceIOError
from agentcore.workspace.server import ServerWorkspace


def _ctx(root: Path) -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=ServerWorkspace(root=root, sandbox=SubprocessSandbox()),
        user_id="u",
    )


async def test_apply_patch_updates_multiple_files(tmp_path: Path):
    (tmp_path / "a.py").write_text("value = 1\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("name = 'old'\n", encoding="utf-8")

    result = await ApplyPatchTool().execute(
        {
            "edits": [
                {
                    "file_path": "a.py",
                    "old_string": "value = 1",
                    "new_string": "value = 2",
                },
                {
                    "file_path": "b.py",
                    "old_string": "name = 'old'",
                    "new_string": "name = 'new'",
                },
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is True
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "value = 2\n"
    assert (tmp_path / "b.py").read_text(encoding="utf-8") == "name = 'new'\n"
    assert result.metadata == {"files": 2, "replacements": 2, "dry_run": False}
    assert {product.path for product in result.file_products} == {"a.py", "b.py"}


async def test_apply_patch_applies_multiple_edits_to_same_file(tmp_path: Path):
    (tmp_path / "a.py").write_text("a = 1\nb = 2\n", encoding="utf-8")

    result = await ApplyPatchTool().execute(
        {
            "edits": [
                {"file_path": "a.py", "old_string": "a = 1", "new_string": "a = 3"},
                {"file_path": "a.py", "old_string": "b = 2", "new_string": "b = 4"},
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is True
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "a = 3\nb = 4\n"


async def test_apply_patch_preflight_failure_writes_nothing(tmp_path: Path):
    (tmp_path / "a.py").write_text("value = 1\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("untouched\n", encoding="utf-8")

    result = await ApplyPatchTool().execute(
        {
            "edits": [
                {"file_path": "a.py", "old_string": "value = 1", "new_string": "value = 2"},
                {"file_path": "b.py", "old_string": "missing", "new_string": "x"},
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is False
    assert result.contract_failure is True
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "value = 1\n"
    assert (tmp_path / "b.py").read_text(encoding="utf-8") == "untouched\n"


async def test_apply_patch_dry_run_does_not_write(tmp_path: Path):
    (tmp_path / "a.py").write_text("value = 1\n", encoding="utf-8")

    result = await ApplyPatchTool().execute(
        {
            "edits": [
                {"file_path": "a.py", "old_string": "value = 1", "new_string": "value = 2"}
            ],
            "dry_run": True,
        },
        _ctx(tmp_path),
    )

    assert result.success is True
    assert result.metadata["dry_run"] is True
    assert result.file_products == []
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "value = 1\n"


async def test_apply_patch_rechecks_file_before_write(tmp_path: Path, monkeypatch):
    (tmp_path / "a.py").write_text("a = 1\n", encoding="utf-8")
    ctx = _ctx(tmp_path)
    original_read = ctx.backend.read
    reads = 0

    async def racing_read(path: str) -> str:
        nonlocal reads
        reads += 1
        if reads >= 3:
            return "a = 9\n"
        return await original_read(path)

    monkeypatch.setattr(ctx.backend, "read", racing_read)
    result = await ApplyPatchTool().execute(
        {
            "edits": [
                {"file_path": "a.py", "old_string": "a = 1", "new_string": "a = 2"}
            ]
        },
        ctx,
    )

    assert result.success is False
    assert result.contract_failure is True
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "a = 1\n"


async def test_apply_patch_rolls_back_completed_files_on_write_failure(
    tmp_path: Path, monkeypatch
):
    (tmp_path / "a.py").write_text("a = 1\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("b = 1\n", encoding="utf-8")
    ctx = _ctx(tmp_path)
    original_write = ctx.backend.write

    async def flaky_write(path: str, content: str) -> int:
        if path == "b.py":
            raise WorkspaceIOError("disk full")
        return await original_write(path, content)

    monkeypatch.setattr(ctx.backend, "write", flaky_write)
    result = await ApplyPatchTool().execute(
        {
            "edits": [
                {"file_path": "a.py", "old_string": "a = 1", "new_string": "a = 2"},
                {"file_path": "b.py", "old_string": "b = 1", "new_string": "b = 2"},
            ]
        },
        ctx,
    )

    assert result.success is False
    assert "已回滚 1/1" in (result.error or "")
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "a = 1\n"
    assert (tmp_path / "b.py").read_text(encoding="utf-8") == "b = 1\n"


async def test_apply_patch_rejects_user_rule_bypass(tmp_path: Path):
    result = await ApplyPatchTool().execute(
        {
            "edits": [
                {
                    "file_path": ".agentcore/rules/style.md",
                    "old_string": "old",
                    "new_string": "new",
                }
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is False
    assert result.contract_failure is True
    assert "用户规则" in (result.error or "")
