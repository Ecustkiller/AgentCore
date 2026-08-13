"""A1+ turn baseline snapshot — best-effort freeze before writes.

Cloud (``run_and_persist``): labeled OSS/FS snapshot, id → ``messages.baseline_snapshot_id``.
Local (sidecar ``_run_turn``): zip beside the workspace at
``AgentCore/baselines/{message_id}.zip`` (id = message_id; no DB required).
Local (desktop channel ``LocalWorkspace``): same zip path on the user disk via
``WorkspaceOp.ENSURE_TURN_BASELINE`` — server never pretends to own a Path.root.

失败 / 超限 / 超时只打日志，绝不阻断回合；桌面降级 A1 工具参数预览。

保留：本地基线区在每次捕获后顺带清理（:func:`prune_local_baselines`，数量上限 ∧ TTL，
对齐云端 D+C），清理失败同样只打日志。用户命名版本区 ``AgentCore/versions`` 永不自动
清理，不在本模块视野内。

**分轨（脚本破坏可回滚 P0a）**：常规 :func:`maybe_capture_turn_baseline` 仍永不阻断。
仅 Local 破坏性删路径经 :func:`ensure_local_baseline_for_destructive` 在无还原点时
由调用方升为 FORCE_APPROVAL / DENY——本模块仍只返回 ``None``/``False``，不抛不拦。
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from stat import S_ISREG
from typing import Any

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.folders.placement import resolve_folder_placement
from agentcore.storage._archive import ArchiveLimitError, zip_dir
from agentcore.workspace.protocol import WorkspaceBackend
from agentcore.workspace.snapshots import create_snapshot
from agentcore.workspace.stage_dirs import BASELINES_REL

logger = get_logger(__name__)

# Align desktop handoff ARCHIVE_MAX_* (apps/desktop/.../fs/constants.ts).
LOCAL_BASELINE_MAX_FILES = 20_000
LOCAL_BASELINE_MAX_BYTES = 100 * 1024 * 1024  # 100 MiB raw
LOCAL_BASELINE_TIMEOUT_S = 60.0


def local_baselines_root(workspace_root: Path) -> Path:
    """``AgentCore/baselines`` under the bound workspace root (not created)."""
    return workspace_root / Path(*BASELINES_REL.split("/"))


def local_baseline_path(workspace_root: Path, snapshot_id: str) -> Path:
    """``AgentCore/baselines/{snapshot_id}.zip`` under the bound workspace root."""
    return local_baselines_root(workspace_root) / f"{snapshot_id}.zip"


def local_baseline_ready(workspace_root: Path, snapshot_id: str) -> bool:
    """True when a non-empty Local zip baseline exists for ``snapshot_id``."""
    if not snapshot_id or not str(snapshot_id).strip():
        return False
    path = local_baseline_path(workspace_root, snapshot_id)
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def prune_local_baselines(
    workspace_root: Path,
    *,
    keep: int,
    max_age_days: int,
    keep_id: str | None = None,
    now: datetime | None = None,
) -> list[str]:
    """Delete baseline zips beyond the newest ``keep`` or older than the TTL.

    Same D+C policy as the cloud system snapshot caps (``snapshot_kinds``), on
    file mtime — the zip stem is a message id, not a timestamp. ``keep`` /
    ``max_age_days`` at ``0`` disable that leg; ``keep_id`` (the baseline just
    captured) is never deleted. Returns the deleted snapshot ids.

    Only ``AgentCore/baselines/*.zip`` is read: the sibling ``versions`` zone is
    user-named and never auto-pruned. Unlike the cloud path there is nothing to
    pin — the local zone has no DB, and a pruned turn simply loses its restore
    entry (the panel scans the zone to decide what it can offer).

    Raises ``OSError`` when the zone itself cannot be read; a single zip that
    resists deletion (Windows sharing violation) is skipped, not fatal.
    """
    keep_cap = keep if keep > 0 else None
    max_age = timedelta(days=max_age_days) if max_age_days > 0 else None
    if keep_cap is None and max_age is None:
        return []

    root = local_baselines_root(workspace_root)
    try:
        children = list(root.iterdir())
    except FileNotFoundError:
        return []

    dated: list[tuple[float, Path]] = []
    for child in children:
        if child.suffix != ".zip":
            continue
        try:
            st = child.stat()
        except OSError:
            continue
        if not S_ISREG(st.st_mode):
            continue
        dated.append((st.st_mtime, child))
    # Newest first; the name breaks mtime ties so the survivors are deterministic.
    dated.sort(key=lambda item: (item[0], item[1].name), reverse=True)

    cutoff = (_aware(now) - max_age).timestamp() if max_age is not None else None
    removed: list[str] = []
    for index, (mtime, path) in enumerate(dated):
        if keep_id is not None and path.stem == keep_id:
            continue
        beyond_cap = keep_cap is not None and index >= keep_cap
        too_old = cutoff is not None and mtime < cutoff
        if not (beyond_cap or too_old):
            continue
        try:
            path.unlink()
        except OSError:
            continue
        removed.append(path.stem)
    return removed


def _aware(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(UTC)
    return now if now.tzinfo is not None else now.replace(tzinfo=UTC)


class _LocalBackendMarker:
    """Minimal stand-in so capture helpers see ``location == "local"``."""

    location = "local"


def _path_root(backend: Any, workspace_root: Path | None) -> Path | None:
    """Sidecar ``ServerWorkspace(location=local).root`` or explicit override."""
    if workspace_root is not None:
        return workspace_root
    root = getattr(backend, "root", None)
    return root if isinstance(root, Path) else None


async def maybe_capture_turn_baseline(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    message_id: str,
    backend: WorkspaceBackend,
    workspace_root: Path | None = None,
) -> str | None:
    """Snapshot the workspace before the turn mutates it. Returns snapshot id or None.

    ``backend.location == "server"`` → cloud labeled snapshot (+ DB id stamp).
    ``backend.location == "local"`` + Path root → local zip under ``workspace_root``
    (sidecar).
    ``backend.location == "local"`` + channel ``LocalWorkspace`` → desktop
    ``ensure_turn_baseline`` op (no server Path).

    Never raises to block the turn — failures log and return ``None``.
    """
    if backend.location == "local":
        root = _path_root(backend, workspace_root)
        if root is not None:
            return await _capture_local_baseline(
                workspace_root=root,
                conversation_id=conversation_id,
                message_id=message_id,
            )
        capture = getattr(backend, "capture_turn_baseline", None)
        if callable(capture):
            try:
                sid = await capture(message_id)
            except Exception:
                logger.warning(
                    "turn.local_baseline_failed",
                    conversation_id=conversation_id,
                    message_id=message_id,
                    phase="channel_maybe_capture",
                    exc_info=True,
                )
                return None
            return sid if isinstance(sid, str) and sid.strip() else None
        return None
    if backend.location != "server":
        return None
    return await _capture_cloud_baseline(
        user_id=user_id,
        folder_id=folder_id,
        conversation_id=conversation_id,
        message_id=message_id,
    )


async def ensure_local_baseline_for_destructive(
    *,
    user_id: str,
    conversation_id: str,
    message_id: str,
    workspace_root: Path | None = None,
    backend: Any | None = None,
) -> bool:
    """P0b: ensure a usable Local zip exists before a destructive script/shell call.

    Path root (sidecar): if a zip is already present, returns True without re-zipping;
    otherwise attempts the same capture path as :func:`maybe_capture_turn_baseline`
    (still best-effort internally — never raises). Returns whether a usable zip is
    available afterward.

    Channel LocalWorkspace (no Path.root): asks the desktop
    ``ensure_turn_baseline`` op, which must probe a non-empty zip (no fake ready).

    Local-only; callers must not route cloud ``restoreSnapshot`` through this path.
    """
    mid = (message_id or "").strip()
    if not mid:
        return False

    root = _path_root(backend, workspace_root)
    if root is not None:
        if local_baseline_ready(root, mid):
            return True
        sid = await maybe_capture_turn_baseline(
            user_id=user_id,
            folder_id=None,
            conversation_id=conversation_id,
            message_id=mid,
            backend=_LocalBackendMarker(),  # type: ignore[arg-type]
            workspace_root=root,
        )
        if sid and local_baseline_ready(root, sid):
            return True
        return local_baseline_ready(root, mid)

    if backend is not None:
        ensure_fn = getattr(backend, "ensure_turn_baseline_ready", None)
        if callable(ensure_fn):
            try:
                return bool(await ensure_fn(mid))
            except Exception:
                logger.warning(
                    "turn.local_baseline_failed",
                    conversation_id=conversation_id,
                    message_id=mid,
                    phase="destructive_ensure_channel",
                    exc_info=True,
                )
                return False
    return False


async def _capture_cloud_baseline(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    message_id: str,
) -> str | None:
    if not settings.workspace_snapshot_enabled:
        return None
    label = f"turn-baseline:{message_id}"
    try:
        placement = await resolve_folder_placement(folder_id)
        ref = await create_snapshot(
            user_id=user_id,
            folder_id=folder_id,
            folder_rel_path=placement.rel_path,
            conversation_id=conversation_id,
            label=label,
        )
    except Exception:
        logger.warning(
            "turn.baseline_snapshot_failed",
            conversation_id=conversation_id,
            message_id=message_id,
            exc_info=True,
        )
        return None

    try:
        # Lazy import: avoid pulling db.repositories at module import (circular with runtime).
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories.messages import MessageRepository

        async with async_session_factory() as session:
            await MessageRepository(session).set_baseline_snapshot_id(
                message_id,
                conversation_id=conversation_id,
                snapshot_id=ref.snapshot_id,
            )
    except Exception:
        logger.warning(
            "turn.baseline_snapshot_id_persist_failed",
            conversation_id=conversation_id,
            message_id=message_id,
            snapshot_id=ref.snapshot_id,
            exc_info=True,
        )
        return ref.snapshot_id

    logger.info(
        "turn.baseline_snapshot",
        conversation_id=conversation_id,
        message_id=message_id,
        snapshot_id=ref.snapshot_id,
    )
    return ref.snapshot_id


def _zip_local_baseline_sync(workspace_root: Path, dest: Path) -> int:
    """Zip workspace into ``dest``; return byte size. Raises ArchiveLimitError."""
    data = zip_dir(
        workspace_root,
        max_files=LOCAL_BASELINE_MAX_FILES,
        max_bytes=LOCAL_BASELINE_MAX_BYTES,
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Atomic-ish: write sibling then replace.
    tmp = dest.with_suffix(".zip.tmp")
    tmp.write_bytes(data)
    tmp.replace(dest)
    return len(data)


async def _capture_local_baseline(
    *,
    workspace_root: Path,
    conversation_id: str,
    message_id: str,
) -> str | None:
    """Best-effort local zip; snapshot id == message_id (path convention, no DB)."""
    dest = local_baseline_path(workspace_root, message_id)
    try:
        size = await asyncio.wait_for(
            asyncio.to_thread(_zip_local_baseline_sync, workspace_root, dest),
            timeout=LOCAL_BASELINE_TIMEOUT_S,
        )
    except TimeoutError:
        logger.warning(
            "turn.local_baseline_skipped",
            conversation_id=conversation_id,
            message_id=message_id,
            reason="timeout",
            timeout_s=LOCAL_BASELINE_TIMEOUT_S,
        )
        return None
    except ArchiveLimitError as e:
        logger.warning(
            "turn.local_baseline_skipped",
            conversation_id=conversation_id,
            message_id=message_id,
            reason=e.reason,
            file_count=e.file_count,
            total_bytes=e.total_bytes,
        )
        return None
    except Exception:
        logger.warning(
            "turn.local_baseline_failed",
            conversation_id=conversation_id,
            message_id=message_id,
            exc_info=True,
        )
        return None

    logger.info(
        "turn.local_baseline_snapshot",
        conversation_id=conversation_id,
        message_id=message_id,
        snapshot_id=message_id,
        size_bytes=size,
        path=str(dest),
    )
    await _prune_local_baselines_best_effort(
        workspace_root=workspace_root,
        conversation_id=conversation_id,
        message_id=message_id,
    )
    return message_id


async def _prune_local_baselines_best_effort(
    *,
    workspace_root: Path,
    conversation_id: str,
    message_id: str,
) -> None:
    """Cap the baselines zone after it grew. Never raises — capture already won.

    Pruning on capture (rather than on read) mirrors the cloud path, where
    ``create_snapshot`` prunes right after writing: capture is the only moment
    the zone grows on either local write track, and the zone has no product
    "list" op to hang cleanup off — the sidecar opens one zip by id, and the
    desktop panel discovers baselines through the generic directory listing.
    """
    try:
        removed = await asyncio.to_thread(
            prune_local_baselines,
            workspace_root,
            keep=settings.workspace_local_baseline_max,
            max_age_days=settings.workspace_local_baseline_retention_days,
            keep_id=message_id,
        )
    except Exception:
        logger.warning(
            "turn.local_baseline_prune_failed",
            conversation_id=conversation_id,
            message_id=message_id,
            exc_info=True,
        )
        return
    if removed:
        logger.info(
            "turn.local_baseline_pruned",
            conversation_id=conversation_id,
            message_id=message_id,
            removed_count=len(removed),
            keep=settings.workspace_local_baseline_max,
            retention_days=settings.workspace_local_baseline_retention_days,
        )
