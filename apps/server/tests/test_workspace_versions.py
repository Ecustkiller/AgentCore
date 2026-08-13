"""本地工作区命名版本：创建 / 列举 / 恢复 / 删除 + 元数据读写 + sidecar RPC 接缝。

命名版本是**用户显式动作**（与 best-effort 的回合基线分轨），所以这里逐条断言
「失败必须抛 / 必须回 error」，而不是像基线那样允许静默降级。
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest

from agentcore.sidecar import protocol
from agentcore.sidecar.server import SidecarServer
from agentcore.workspace._paths import is_ignored_dir_entry, is_internal_zone_relpath
from agentcore.workspace.versions import (
    CONTENT_NAME,
    META_NAME,
    InvalidVersionIdError,
    InvalidVersionNameError,
    VersionNotFoundError,
    create_workspace_version,
    delete_workspace_version,
    is_valid_version_id,
    list_workspace_versions,
    restore_workspace_version,
    versions_root,
)


def _zip_names(path: Path) -> set[str]:
    with zipfile.ZipFile(io.BytesIO(path.read_bytes())) as zf:
        return {i.filename for i in zf.infolist()}


# --- 内部区名单（漏改一侧 → 版本 zip 会被当普通用户文件 grep / 索引 / 打进基线）---


def test_versions_zone_is_path_aware_internal():
    assert is_internal_zone_relpath("AgentCore/versions")
    assert is_internal_zone_relpath("AgentCore/versions/2026-1/content.zip")
    # 裸名 versions（用户自己的目录）不得误伤
    assert not is_internal_zone_relpath("versions/x")
    assert is_ignored_dir_entry(parent_rel="AgentCore", name="versions")
    assert not is_ignored_dir_entry(parent_rel="", name="versions")


# --- 创建 / 列举 / 恢复 / 删除 ---


@pytest.mark.asyncio
async def test_create_list_restore_delete_round_trip(tmp_path: Path):
    (tmp_path / "a.txt").write_text("v1", encoding="utf-8")

    created = await create_workspace_version(workspace_root=tmp_path, name="第一版")
    assert created.name == "第一版"
    assert created.size_bytes > 0

    listed = await list_workspace_versions(workspace_root=tmp_path)
    assert [v.version_id for v in listed] == [created.version_id]
    assert listed[0].name == "第一版"
    assert listed[0].created_at == created.created_at
    assert listed[0].size_bytes == created.size_bytes

    (tmp_path / "a.txt").write_text("v2", encoding="utf-8")
    restored = await restore_workspace_version(
        workspace_root=tmp_path, version_id=created.version_id
    )
    assert restored.version_id == created.version_id
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "v1"

    await delete_workspace_version(
        workspace_root=tmp_path, version_id=created.version_id
    )
    assert await list_workspace_versions(workspace_root=tmp_path) == []
    assert not (versions_root(tmp_path) / created.version_id).exists()


@pytest.mark.asyncio
async def test_meta_json_written_and_read_back(tmp_path: Path):
    (tmp_path / "note.md").write_text("hello", encoding="utf-8")
    created = await create_workspace_version(workspace_root=tmp_path, name="  留一版  ")

    entry_dir = versions_root(tmp_path) / created.version_id
    meta = json.loads((entry_dir / META_NAME).read_text(encoding="utf-8"))
    assert meta == {
        "version_id": created.version_id,
        "name": "留一版",  # 名字入盘前 trim
        "created_at": created.created_at,
        "size_bytes": created.size_bytes,
    }
    assert _zip_names(entry_dir / CONTENT_NAME) == {"note.md"}
    # tmp 文件不得留在盘上
    assert not (entry_dir / f"{CONTENT_NAME}.tmp").exists()


@pytest.mark.asyncio
async def test_list_is_newest_first(tmp_path: Path):
    (tmp_path / "a.txt").write_text("x", encoding="utf-8")
    first = await create_workspace_version(workspace_root=tmp_path, name="一")
    second = await create_workspace_version(workspace_root=tmp_path, name="二")
    listed = await list_workspace_versions(workspace_root=tmp_path)
    assert [v.name for v in listed] == ["二", "一"]
    assert [v.version_id for v in listed] == [second.version_id, first.version_id]


@pytest.mark.asyncio
async def test_version_zip_excludes_internal_zones(tmp_path: Path):
    (tmp_path / "keep.txt").write_text("keep", encoding="utf-8")
    baselines = tmp_path / "AgentCore" / "baselines"
    baselines.mkdir(parents=True)
    (baselines / "m1.zip").write_bytes(b"PK\x03\x04stale")
    # 先留一版，再留第二版：第二版不得把第一版的 zip 打进去（否则版本会指数膨胀）
    await create_workspace_version(workspace_root=tmp_path, name="一")
    second = await create_workspace_version(workspace_root=tmp_path, name="二")

    names = _zip_names(versions_root(tmp_path) / second.version_id / CONTENT_NAME)
    assert names == {"keep.txt"}


@pytest.mark.asyncio
async def test_restore_is_overlay_not_mirror(tmp_path: Path):
    (tmp_path / "a.txt").write_text("v1", encoding="utf-8")
    created = await create_workspace_version(workspace_root=tmp_path, name="一")
    (tmp_path / "later.txt").write_text("new", encoding="utf-8")

    await restore_workspace_version(
        workspace_root=tmp_path, version_id=created.version_id
    )
    # 与本机回合基线回退语义一致：解压覆盖，不清空
    assert (tmp_path / "later.txt").read_text(encoding="utf-8") == "new"
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "v1"


@pytest.mark.asyncio
async def test_missing_zone_lists_empty(tmp_path: Path):
    assert await list_workspace_versions(workspace_root=tmp_path) == []


@pytest.mark.asyncio
async def test_half_written_version_is_not_listed(tmp_path: Path):
    entry_dir = versions_root(tmp_path) / "20260101T000000Z-deadbeef"
    entry_dir.mkdir(parents=True)
    (entry_dir / META_NAME).write_text(
        json.dumps(
            {
                "version_id": entry_dir.name,
                "name": "半截",
                "created_at": "2026-01-01T00:00:00+00:00",
                "size_bytes": 10,
            }
        ),
        encoding="utf-8",
    )
    # 没有 content.zip：列出来就是个恢复不了的还原点
    assert await list_workspace_versions(workspace_root=tmp_path) == []
    with pytest.raises(VersionNotFoundError):
        await restore_workspace_version(
            workspace_root=tmp_path, version_id=entry_dir.name
        )


@pytest.mark.asyncio
async def test_malformed_meta_is_skipped(tmp_path: Path):
    (tmp_path / "a.txt").write_text("v1", encoding="utf-8")
    good = await create_workspace_version(workspace_root=tmp_path, name="好的")

    broken = versions_root(tmp_path) / "20260101T000000Z-cafebabe"
    broken.mkdir(parents=True)
    (broken / CONTENT_NAME).write_bytes(b"PK\x03\x04")
    (broken / META_NAME).write_text("{ not json", encoding="utf-8")

    listed = await list_workspace_versions(workspace_root=tmp_path)
    assert [v.version_id for v in listed] == [good.version_id]


@pytest.mark.asyncio
async def test_meta_version_id_follows_directory_name(tmp_path: Path):
    """目录名是 id 权威源——meta 被改花了也不能让恢复/删除指向别的版本。"""
    (tmp_path / "a.txt").write_text("v1", encoding="utf-8")
    created = await create_workspace_version(workspace_root=tmp_path, name="一")
    entry_dir = versions_root(tmp_path) / created.version_id
    meta = json.loads((entry_dir / META_NAME).read_text(encoding="utf-8"))
    meta["version_id"] = "someone-elses-id"
    (entry_dir / META_NAME).write_text(json.dumps(meta), encoding="utf-8")

    listed = await list_workspace_versions(workspace_root=tmp_path)
    assert [v.version_id for v in listed] == [created.version_id]


# --- 安全校验与入参 ---


@pytest.mark.parametrize(
    "bad",
    ["", " ", ".", "..", "../evil", "a/b", "a\\b", "-lead", "x" * 65],
)
def test_invalid_version_ids_rejected(bad: str):
    assert not is_valid_version_id(bad)


def test_valid_version_id_shape():
    assert is_valid_version_id("20260814T010203Z-a1b2c3d4")


@pytest.mark.asyncio
async def test_path_escaping_version_id_raises(tmp_path: Path):
    for bad in ("../../etc", "a/b", "..\\win"):
        with pytest.raises(InvalidVersionIdError):
            await restore_workspace_version(workspace_root=tmp_path, version_id=bad)
        with pytest.raises(InvalidVersionIdError):
            await delete_workspace_version(workspace_root=tmp_path, version_id=bad)


@pytest.mark.asyncio
async def test_blank_name_rejected(tmp_path: Path):
    with pytest.raises(InvalidVersionNameError):
        await create_workspace_version(workspace_root=tmp_path, name="   ")
    with pytest.raises(InvalidVersionNameError):
        await create_workspace_version(workspace_root=tmp_path, name="名" * 201)


@pytest.mark.asyncio
async def test_delete_unknown_version_raises(tmp_path: Path):
    with pytest.raises(VersionNotFoundError):
        await delete_workspace_version(
            workspace_root=tmp_path, version_id="20260101T000000Z-deadbeef"
        )


# --- sidecar JSON-RPC 接缝（create / restore 只走这条；list / delete 走桌面 FS IPC）---


def _recorder() -> tuple[list[dict[str, Any]], Any]:
    sent: list[dict[str, Any]] = []

    async def write_line(line: str) -> None:
        sent.append(json.loads(line))

    return sent, write_line


def _response(sent: list[dict[str, Any]], request_id: Any) -> dict[str, Any]:
    return next(m for m in sent if m.get("id") == request_id)


async def _call(
    server: SidecarServer, request_id: int, method: str, params: dict[str, Any]
) -> None:
    await server.handle_line(
        json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        )
    )


def _rooted_server(root: Path) -> tuple[list[dict[str, Any]], SidecarServer]:
    sent, write_line = _recorder()
    server = SidecarServer(write_line)
    server._root = root.resolve()  # 等价于 initialize 的副作用
    return sent, server


@pytest.mark.asyncio
async def test_sidecar_create_then_restore_workspace_version(tmp_path: Path):
    (tmp_path / "a.txt").write_text("v1", encoding="utf-8")
    sent, server = _rooted_server(tmp_path)

    await _call(server, 1, "createWorkspaceVersion", {"name": "第一版"})
    created = _response(sent, 1)["result"]
    assert created["name"] == "第一版"
    assert created["size_bytes"] > 0
    version_id = created["version_id"]

    (tmp_path / "a.txt").write_text("v2", encoding="utf-8")
    await _call(server, 2, "restoreWorkspaceVersion", {"versionId": version_id})
    restored = _response(sent, 2)["result"]
    assert restored["ok"] is True
    assert restored["version_id"] == version_id
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "v1"


@pytest.mark.asyncio
async def test_sidecar_create_rejects_blank_name(tmp_path: Path):
    sent, server = _rooted_server(tmp_path)
    await _call(server, 3, "createWorkspaceVersion", {"name": "  "})
    assert _response(sent, 3)["error"]["code"] == protocol.INVALID_PARAMS


@pytest.mark.asyncio
async def test_sidecar_restore_requires_version_id(tmp_path: Path):
    sent, server = _rooted_server(tmp_path)
    await _call(server, 4, "restoreWorkspaceVersion", {})
    assert _response(sent, 4)["error"]["code"] == protocol.INVALID_PARAMS


@pytest.mark.asyncio
async def test_sidecar_restore_unknown_version_is_invalid_params(tmp_path: Path):
    sent, server = _rooted_server(tmp_path)
    await _call(
        server,
        5,
        "restoreWorkspaceVersion",
        {"versionId": "20260101T000000Z-deadbeef"},
    )
    assert _response(sent, 5)["error"]["code"] == protocol.INVALID_PARAMS


@pytest.mark.asyncio
async def test_sidecar_version_methods_need_initialized_root():
    sent, write_line = _recorder()
    server = SidecarServer(write_line)
    await _call(server, 6, "createWorkspaceVersion", {"name": "x"})
    assert _response(sent, 6)["error"]["code"] == protocol.INVALID_REQUEST
    await _call(server, 7, "restoreWorkspaceVersion", {"versionId": "x"})
    assert _response(sent, 7)["error"]["code"] == protocol.INVALID_REQUEST
