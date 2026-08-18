"""One-way workspace → organize-mount copy (cross-root). Reverse / move stay denied."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock

import pytest

from agentcore.workspace.channel import WorkspaceChannel, WorkspaceOp
from agentcore.workspace.external_mounts import (
    ExternalMount,
    cross_root_copy_error,
    cross_root_move_error,
)
from agentcore.workspace.local import LocalWorkspace
from agentcore.workspace.protocol import AlreadyExists, OutsideWorkspace, WorkspaceIOError
from agentcore.workspace.server import ServerWorkspace


class _Sandbox:
    async def execute(self, req):
        from agentcore.tools.sandbox.protocol import ExecutionResult

        return ExecutionResult(
            success=True, stdout="", stderr="", exit_code=0, duration_ms=0
        )


def _server(
    ws_root: Path,
    ext_root: Path,
    *,
    mode: Literal["readonly", "organize"] = "organize",
) -> ServerWorkspace:
    ws = ServerWorkspace(ws_root, _Sandbox(), location="local")
    ws.attach_external_mounts(
        {
            "out": ExternalMount(
                alias="out",
                root_id="ext-out",
                label="out",
                abs_path=str(ext_root),
                mode=mode,
            )
        }
    )
    return ws


def _local(
    *, mode: Literal["readonly", "organize"] = "organize"
) -> tuple[LocalWorkspace, AsyncMock]:
    channel = AsyncMock(spec=WorkspaceChannel)
    channel.root_id = "primary"
    channel.conversation_id = "c1"
    channel.request = AsyncMock(return_value=None)
    ws = LocalWorkspace(channel)
    ws.attach_external_mounts(
        {
            "out": ExternalMount(
                alias="out", root_id="ext-out", label="out", mode=mode
            )
        }
    )
    return ws, channel


def test_cross_root_copy_policy():
    assert cross_root_copy_error(None, None) is None
    assert cross_root_copy_error("a", "a") is None
    assert cross_root_copy_error(None, "desk") is None
    assert "工作区" in (cross_root_copy_error("desk", None) or "")
    assert "授权目录复制" in (cross_root_copy_error("a", "b") or "")


def test_cross_root_move_policy():
    assert cross_root_move_error(None, None) is None
    assert cross_root_move_error("a", "a") is None
    assert "工作区" in (cross_root_move_error(None, "desk") or "")
    assert "工作区" in (cross_root_move_error("desk", None) or "")
    assert "授权目录移动" in (cross_root_move_error("a", "b") or "")


@pytest.mark.asyncio
async def test_workspace_to_organize_copy_succeeds(tmp_path: Path):
    primary = tmp_path / "ws"
    ext = tmp_path / "ext"
    primary.mkdir()
    ext.mkdir()
    (primary / "report.md").write_text("hello", encoding="utf-8")
    ws = _server(primary, ext)

    await ws.copy("report.md", "external/out/report.md")

    assert (primary / "report.md").read_text(encoding="utf-8") == "hello"
    assert (ext / "report.md").read_text(encoding="utf-8") == "hello"
    assert ws.dirty is True


@pytest.mark.asyncio
async def test_workspace_to_organize_copy_refuses_overwrite(tmp_path: Path):
    primary = tmp_path / "ws"
    ext = tmp_path / "ext"
    primary.mkdir()
    ext.mkdir()
    (primary / "report.md").write_text("new", encoding="utf-8")
    (ext / "report.md").write_text("old", encoding="utf-8")
    ws = _server(primary, ext)

    with pytest.raises(AlreadyExists):
        await ws.copy("report.md", "external/out/report.md")

    assert (ext / "report.md").read_text(encoding="utf-8") == "old"
    assert (primary / "report.md").read_text(encoding="utf-8") == "new"


@pytest.mark.asyncio
async def test_workspace_to_readonly_copy_denied(tmp_path: Path):
    primary = tmp_path / "ws"
    ext = tmp_path / "ext"
    primary.mkdir()
    ext.mkdir()
    (primary / "report.md").write_text("hello", encoding="utf-8")
    ws = _server(primary, ext, mode="readonly")

    with pytest.raises(OutsideWorkspace, match="只读|不能写入"):
        await ws.copy("report.md", "external/out/report.md")
    assert not (ext / "report.md").exists()


@pytest.mark.asyncio
async def test_organize_to_workspace_copy_still_denied(tmp_path: Path):
    primary = tmp_path / "ws"
    ext = tmp_path / "ext"
    primary.mkdir()
    ext.mkdir()
    (ext / "report.md").write_text("hello", encoding="utf-8")
    ws = _server(primary, ext)

    with pytest.raises(OutsideWorkspace, match="不能跨会话授权目录与工作区复制文件"):
        await ws.copy("external/out/report.md", "report.md")
    assert not (primary / "report.md").exists()


@pytest.mark.asyncio
async def test_workspace_to_organize_move_still_denied(tmp_path: Path):
    primary = tmp_path / "ws"
    ext = tmp_path / "ext"
    primary.mkdir()
    ext.mkdir()
    (primary / "report.md").write_text("hello", encoding="utf-8")
    ws = _server(primary, ext)

    with pytest.raises(OutsideWorkspace, match="不能跨会话授权目录与工作区移动文件"):
        await ws.move("report.md", "external/out/report.md")
    assert (primary / "report.md").read_text(encoding="utf-8") == "hello"
    assert not (ext / "report.md").exists()


@pytest.mark.asyncio
async def test_organize_write_still_denied_after_copy_allow(tmp_path: Path):
    primary = tmp_path / "ws"
    ext = tmp_path / "ext"
    primary.mkdir()
    ext.mkdir()
    ws = _server(primary, ext)
    with pytest.raises(OutsideWorkspace, match="整理授权|不允许"):
        await ws.write("external/out/a.txt", "nope")
    assert not (ext / "a.txt").exists()


@pytest.mark.asyncio
async def test_copy_dest_traversal_stays_outside_mount(tmp_path: Path):
    primary = tmp_path / "ws"
    ext = tmp_path / "ext"
    primary.mkdir()
    ext.mkdir()
    (primary / "report.md").write_text("hello", encoding="utf-8")
    secret = tmp_path / "secret.txt"
    ws = _server(primary, ext)

    with pytest.raises(OutsideWorkspace):
        await ws.copy("report.md", "external/out/../secret.txt")
    assert not secret.exists()


@pytest.mark.asyncio
async def test_local_workspace_to_organize_copy_issues_copy_on_dest_root():
    ws, channel = _local()
    await ws.copy("report.md", "external/out/report.md")
    channel.request.assert_awaited_once()
    call = channel.request.await_args
    assert call.args[0] == WorkspaceOp.COPY
    assert call.args[1]["src"] == "report.md"
    assert call.args[1]["dst"] == "report.md"
    assert call.args[1]["src_root_id"] == "primary"
    assert call.kwargs.get("root_id") == "ext-out"
    assert ws.dirty is True


def _cloud_server(ws_root: Path) -> tuple[ServerWorkspace, AsyncMock]:
    ws = ServerWorkspace(ws_root, _Sandbox(), location="server")
    channel = AsyncMock(spec=WorkspaceChannel)
    channel.root_id = ""
    channel.conversation_id = "c1"

    async def request(op, args, root_id=None):
        if op == WorkspaceOp.EXISTS:
            return False
        return None

    channel.request = AsyncMock(side_effect=request)
    ws.attach_external_mounts(
        {
            "out": ExternalMount(
                alias="out", root_id="ext-out", label="out", mode="organize"
            )
        }
    )
    ws.attach_external_channel(channel)
    return ws, channel


@pytest.mark.asyncio
async def test_cloud_workspace_to_organize_copy_sends_src_data(tmp_path: Path):
    primary = tmp_path / "ws"
    primary.mkdir()
    (primary / "report.md").write_text("hello", encoding="utf-8")
    ws, channel = _cloud_server(primary)

    await ws.copy("report.md", "external/out/report.md")

    copy_calls = [
        c for c in channel.request.await_args_list if c.args[0] == WorkspaceOp.COPY
    ]
    assert len(copy_calls) == 1
    payload = copy_calls[0].args[1]
    assert payload["dst"] == "report.md"
    assert "src_root_id" not in payload
    assert base64.b64decode(payload["src_data"]) == b"hello"
    assert copy_calls[0].kwargs.get("root_id") == "ext-out"
    assert ws.dirty is True


@pytest.mark.asyncio
async def test_cloud_workspace_to_organize_copy_tree_mkdir_and_files(tmp_path: Path):
    primary = tmp_path / "ws"
    tree = primary / "pack"
    tree.mkdir(parents=True)
    (tree / "a.txt").write_text("A", encoding="utf-8")
    (tree / "sub").mkdir()
    (tree / "sub" / "b.txt").write_text("B", encoding="utf-8")
    ws, channel = _cloud_server(primary)

    await ws.copy("pack", "external/out/pack")

    ops = [c.args[0] for c in channel.request.await_args_list]
    assert WorkspaceOp.MKDIR in ops
    copy_calls = [
        c for c in channel.request.await_args_list if c.args[0] == WorkspaceOp.COPY
    ]
    bodies = {base64.b64decode(c.args[1]["src_data"]) for c in copy_calls}
    assert bodies == {b"A", b"B"}


@pytest.mark.asyncio
async def test_local_workspace_copy_without_src_root_refuses_path_copy():
    ws, channel = _local()
    channel.root_id = ""
    with pytest.raises(WorkspaceIOError, match="不在本机"):
        await ws.copy("report.md", "external/out/report.md")
    channel.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_copy_from_bytes_refuses_over_upload_ceiling(monkeypatch):
    from agentcore.config import settings

    monkeypatch.setattr(settings, "workspace_upload_max_bytes", 8)
    ws, channel = _local()
    with pytest.raises(WorkspaceIOError, match="交付上限"):
        await ws.copy_from_bytes("external/out/big.bin", b"0123456789")
    channel.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_local_workspace_to_readonly_copy_denied():
    ws, channel = _local(mode="readonly")
    with pytest.raises(OutsideWorkspace, match="只读|不能写入"):
        await ws.copy("report.md", "external/out/report.md")
    channel.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_local_organize_to_workspace_copy_still_denied():
    ws, channel = _local()
    with pytest.raises(OutsideWorkspace, match="不能跨会话授权目录与工作区复制文件"):
        await ws.copy("external/out/report.md", "report.md")
    channel.request.assert_not_awaited()


@pytest.mark.asyncio
async def test_local_workspace_to_organize_move_still_denied():
    ws, channel = _local()
    with pytest.raises(OutsideWorkspace, match="不能跨会话授权目录与工作区移动文件"):
        await ws.move("report.md", "external/out/report.md")
    channel.request.assert_not_awaited()
