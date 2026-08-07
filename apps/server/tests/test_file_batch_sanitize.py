"""file_batch write-path sanitize: dossier flatten + idempotent same-target."""

from __future__ import annotations

from pathlib import Path

import pytest

from agentcore.tools.builtin.file_ops import FileBatchTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace
from agentcore.workspace.stage_dirs import REVIEWS_PREFIX


def _ctx(workspace: Path) -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=workspace, sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _seed_reviews_layout(tmp_path: Path) -> Path:
    reviews = tmp_path / "AgentCore" / "文档" / "reviews"
    reviews.mkdir(parents=True)
    return reviews


@pytest.mark.asyncio
async def test_batch_move_nested_reviews_lands_flat(tmp_path: Path):
    reviews = _seed_reviews_layout(tmp_path)
    src = reviews / "src.md"
    src.write_text("review", encoding="utf-8")
    nested_dest = f"{REVIEWS_PREFIX}a/b.md"
    flat_dest = f"{REVIEWS_PREFIX}a_b.md"

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
    assert flat_dest in result.output
    assert "请求路径已清理" in result.output
    assert (tmp_path / Path(flat_dest)).read_text(encoding="utf-8") == "review"
    assert not (reviews / "a").exists()
    assert not src.exists()


@pytest.mark.asyncio
async def test_batch_copy_nested_reviews_lands_flat(tmp_path: Path):
    reviews = _seed_reviews_layout(tmp_path)
    src = reviews / "src.md"
    src.write_text("copy-me", encoding="utf-8")
    nested_dest = f"{REVIEWS_PREFIX}a/b.md"
    flat_dest = f"{REVIEWS_PREFIX}a_b.md"

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
    assert (tmp_path / Path(flat_dest)).read_text(encoding="utf-8") == "copy-me"
    assert src.read_text(encoding="utf-8") == "copy-me"
    assert not (reviews / "a").exists()
    assert "请求路径已清理" in result.output


@pytest.mark.asyncio
async def test_batch_move_flat_to_nested_same_target_is_idempotent(tmp_path: Path):
    reviews = _seed_reviews_layout(tmp_path)
    flat = reviews / "a_b.md"
    flat.write_text("already-flat", encoding="utf-8")
    flat_rel = f"{REVIEWS_PREFIX}a_b.md"
    nested_rel = f"{REVIEWS_PREFIX}a/b.md"

    result = await FileBatchTool().execute(
        {
            "operations": [
                {"op": "move", "source": flat_rel, "destination": nested_rel}
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is True
    assert result.metadata["ok"] == 1
    assert result.metadata["fail"] == 0
    assert "无需操作" in result.output
    assert "请求路径已清理" in result.output
    assert flat.read_text(encoding="utf-8") == "already-flat"
    assert not (reviews / "a").exists()
    assert list(reviews.iterdir()) == [flat]


@pytest.mark.asyncio
async def test_batch_delete_nested_path_hits_flat_file(tmp_path: Path):
    reviews = _seed_reviews_layout(tmp_path)
    flat = reviews / "a_b.md"
    flat.write_text("gone", encoding="utf-8")

    result = await FileBatchTool().execute(
        {
            "operations": [
                {
                    "op": "delete",
                    "path": f"{REVIEWS_PREFIX}a/b.md",
                    "permanent": True,
                }
            ]
        },
        _ctx(tmp_path),
    )

    assert result.success is True
    assert not flat.exists()
    assert f"{REVIEWS_PREFIX}a_b.md" in result.output
    assert not (reviews / "a").exists()


@pytest.mark.asyncio
async def test_batch_mkdir_nested_reviews_flattens(tmp_path: Path):
    _seed_reviews_layout(tmp_path)
    flat_dir = f"{REVIEWS_PREFIX}a_b"

    result = await FileBatchTool().execute(
        {"operations": [{"op": "mkdir", "path": f"{REVIEWS_PREFIX}a/b"}]},
        _ctx(tmp_path),
    )

    assert result.success is True
    assert (tmp_path / Path(flat_dir)).is_dir()
    assert not (tmp_path / "AgentCore" / "文档" / "reviews" / "a").exists()
    assert "请求路径已清理" in result.output
