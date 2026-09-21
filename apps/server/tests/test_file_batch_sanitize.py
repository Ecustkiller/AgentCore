"""file_batch write-path sanitize: nested dirs stay nested; same-target is idempotent."""

from __future__ import annotations

from pathlib import Path

import pytest

from agentcore.tools.builtin.file_ops import FileBatchTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

REVIEWS_PREFIX = "notes/"


def _ctx(workspace: Path) -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=workspace, sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _seed_reviews_layout(tmp_path: Path) -> Path:
    reviews = tmp_path / "notes"
    reviews.mkdir(parents=True)
    return reviews


@pytest.mark.asyncio
async def test_batch_move_keeps_nested_dest(tmp_path: Path):
    reviews = _seed_reviews_layout(tmp_path)
    src = reviews / "src.md"
    src.write_text("review", encoding="utf-8")
    nested_dest = f"{REVIEWS_PREFIX}a/b.md"

    result = await FileBatchTool().execute(
        {
            "operations": [
                {
                    "op": "move",
                    "source": f"{REVIEWS_PREFIX}src.md",
                    "destination": nested_dest,
                }
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is True
    assert result.metadata["ok"] == 1
    assert nested_dest in result.output
    assert (tmp_path / Path(nested_dest)).read_text(encoding="utf-8") == "review"
    assert not src.exists()


@pytest.mark.asyncio
async def test_batch_copy_keeps_nested_dest(tmp_path: Path):
    reviews = _seed_reviews_layout(tmp_path)
    src = reviews / "src.md"
    src.write_text("copy-me", encoding="utf-8")
    nested_dest = f"{REVIEWS_PREFIX}a/b.md"

    result = await FileBatchTool().execute(
        {
            "operations": [
                {
                    "op": "copy",
                    "source": f"{REVIEWS_PREFIX}src.md",
                    "destination": nested_dest,
                }
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is True
    assert (tmp_path / Path(nested_dest)).read_text(encoding="utf-8") == "copy-me"
    assert src.read_text(encoding="utf-8") == "copy-me"


@pytest.mark.asyncio
async def test_batch_move_same_path_is_idempotent(tmp_path: Path):
    reviews = _seed_reviews_layout(tmp_path)
    nested = reviews / "a" / "b.md"
    nested.parent.mkdir(parents=True)
    nested.write_text("already", encoding="utf-8")
    nested_rel = f"{REVIEWS_PREFIX}a/b.md"

    result = await FileBatchTool().execute(
        {
            "operations": [
                {"op": "move", "source": nested_rel, "destination": nested_rel}
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is True
    assert result.metadata["ok"] == 1
    assert result.metadata["fail"] == 0
    assert "无需操作" in result.output or "相同" in result.output
    assert nested.read_text(encoding="utf-8") == "already"


@pytest.mark.asyncio
async def test_batch_mkdir_keeps_nested_dir(tmp_path: Path):
    _seed_reviews_layout(tmp_path)
    nested_dir = f"{REVIEWS_PREFIX}a/b"

    result = await FileBatchTool().execute(
        {"operations": [{"op": "mkdir", "path": nested_dir}]},
        _ctx(tmp_path),
    )

    assert result.success is True
    assert (tmp_path / Path(nested_dir)).is_dir()
