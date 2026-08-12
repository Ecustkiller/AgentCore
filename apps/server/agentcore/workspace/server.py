"""ServerWorkspace — files and code execution on the server (cloud mode).

The first ``WorkspaceBackend`` implementation. It owns a root directory on the
server and a ``SandboxProvider`` for code execution. All filesystem operations
resolve through ``resolve_safe_path`` (the traversal guard, now internal to the
backend), and ``execute`` delegates to the sandbox with ``cwd`` set to the root
so executed code sees the workspace files — fixing the long-standing bug where
``code_execute`` ran in a throwaway temp dir disconnected from file tools.
"""

from __future__ import annotations

import asyncio
import contextlib
import fnmatch
import os
import shutil
import tempfile
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Literal

from agentcore.tools.sandbox.protocol import (
    ExecutionRequest,
    ExecutionResult,
    SandboxProvider,
)
from agentcore.workspace._paths import (
    is_access_denied_oserror,
    is_ignored_dir_entry,
    is_ignored_file_name,
    is_system_ignored_file_name,
    path_has_non_internal_entries,
    resolve_safe_path,
)
from agentcore.workspace.channel import WorkspaceChannel
from agentcore.workspace.declared_dirs import is_declared_latent_dir
from agentcore.workspace.external_mounts import (
    ExternalMount,
    build_external_env,
    external_mutation_allowed,
    external_ns,
    is_external_namespace,
    parse_external_path,
    route_external,
)
from agentcore.workspace.indexing.maintainer import IndexMaintainer
from agentcore.workspace.indexing.manager import IndexManager
from agentcore.workspace.indexing.registry import (
    drop_index_registry,
    shared_index_maintainer,
    shared_index_manager,
)
from agentcore.workspace.limits import FILE_TOO_LARGE_DETAIL, WORKSPACE_READ_MAX_BYTES
from agentcore.workspace.local import LocalWorkspace
from agentcore.workspace.locks import workspace_lock
from agentcore.workspace.protocol import (
    AlreadyExists,
    AmbiguousMatch,
    CodeSearchResult,
    DirEntry,
    GrepQuery,
    GrepResult,
    IndexFileEntry,
    IndexFilesResult,
    NoMatch,
    NotADirectory,
    NotAFile,
    NotUTF8,
    OutsideWorkspace,
    PathNotFound,
    ReadLinesResult,
    ReplaceOutcome,
    TreeEntry,
    TreeResult,
    WorkspaceIOError,
)
from agentcore.workspace.rg_grep import run_grep_rg
from agentcore.workspace.shared_mounts import (
    SharedMount,
    SharedMountMode,
    parse_shared_path,
    readonly_write_error,
    revoked_error,
    route_shared,
    shared_ns,
)
from agentcore.workspace.shared_paths import (
    shared_workspace_root_path,
    shared_workspace_storage_key,
)
from agentcore.workspace.sparse_listing import is_ai_list_hidden_file
from agentcore.workspace.text_replace import (
    TextReplaceAmbiguous,
    TextReplaceNoMatch,
    apply_text_replace,
)
from agentcore.workspace.trash import (
    is_internal_zone_path,
    soft_delete_expanding_trash_ancestor,
    soft_delete_to_trash,
    trash_dest_under_target,
)

_MAX_LIST_ENTRIES = 100
_MAX_INDEX_FILES = 5000  # @ mention flat index cap (mirrors desktop LIST_FILES_CAP)


def _posix(rel: str) -> str:
    return rel.replace(os.sep, "/")


def _collect_index_files_sync(
    root: Path, *, cap: int, recent: bool
) -> IndexFilesResult:
    """Synchronous ``os.walk`` scan — must run off the asyncio event-loop thread."""
    # (posix_path, sort_mtime, mtime_ms, size_bytes)
    collected: list[tuple[str, float, int, int]] = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune noise dirs in place so os.walk never descends into them.
        rel_dir = os.path.relpath(dirpath, root)
        parent_rel = "" if rel_dir == "." else rel_dir.replace("\\", "/")
        dirnames[:] = sorted(
            d for d in dirnames if not is_ignored_dir_entry(parent_rel=parent_rel, name=d)
        )
        for fname in sorted(filenames):
            if is_ignored_file_name(fname):
                continue
            full = Path(dirpath) / fname
            if full.is_symlink() or not full.is_file():
                continue
            try:
                st = full.stat()
            except OSError:
                continue
            mtime_ms = st.st_mtime_ns // 1_000_000
            size_bytes = int(st.st_size)
            sort_mtime = float(st.st_mtime) if recent else 0.0
            collected.append(
                (_posix(os.path.relpath(full, root)), sort_mtime, mtime_ms, size_bytes)
            )
            if len(collected) >= cap:
                truncated = True
                break
        if truncated:
            break
    if recent:
        collected.sort(key=lambda row: row[1], reverse=True)  # newest first
    else:
        collected.sort(key=lambda row: row[0])  # alphabetical
    entries = tuple(
        IndexFileEntry(path=p, mtime_ms=ms, size_bytes=sz)
        for p, _, ms, sz in collected
    )
    return IndexFilesResult(
        paths=[e.path for e in entries],
        truncated=truncated,
        entries=entries,
    )


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write ``data`` to ``path`` atomically (temp file in the same dir + rename).

    Avoids leaving a half-written or truncated file if the process dies mid-write
    — the whole point of an edit tool is to never corrupt the user's file.
    """
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp_str_replace_", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


class ServerWorkspace:
    """``WorkspaceBackend`` backed by a directory + sandbox on the host machine.

    ``location`` defaults to ``"server"`` (an isolated cloud sandbox — workers run
    un-gated). The sidecar reuses this exact backend but passes ``location="local"``:
    there the engine runs ON the user's machine and ``root`` IS their real disk, so a
    delegated worker's ``file_write`` / ``code_execute`` needs the same consent the
    cloud's local mode demands — the gate keys off ``backend.location == "local"``
    (see ``delegate.py`` worker_gate, ``pipeline.py`` revise_gate). Primary-root ops
    use direct ``Path`` I/O either way. Cloud sessions with W3/organize grants (no
    ``abs_path``) additionally attach a ``WorkspaceChannel`` and route **only**
    ``external/<alias>/…`` via per-op ``root_id`` (same transport as
    ``LocalWorkspace``) — ``location`` stays ``"server"`` so worker_gate stays off.
    """

    def __init__(
        self,
        root: Path,
        sandbox: SandboxProvider,
        *,
        root_label: str = "workspace",
        location: Literal["server", "local"] = "server",
        lock_key: str | None = None,
    ) -> None:
        self._root = root
        self._sandbox = sandbox
        self.root_label = root_label
        self.location: Literal["server", "local"] = location
        # A′ sink: primary-tree mutations take this key (cloud builds). None =
        # sidecar / hermetic tests — unlocked (sidecar never held folder lock).
        self._lock_key = lock_key
        # Optional UX hook when mutation lock must wait (不得静默等锁 → SSE).
        self._on_lock_waiting: Callable[[bool], None] | None = None
        # Flips True on the first mutating op so the service snapshots only
        # workspaces a turn actually changed (see WorkspaceBackend.dirty).
        self._dirty = False
        self._index_manager: IndexManager | None = None
        self._index_maintainer: IndexMaintainer | None = None
        # W3 session mounts (``external/<alias>/…``). Sidecar sets ``abs_path``;
        # cloud grants carry ``root_id`` only and need ``_external_bridge``.
        self._mounts: dict[str, ExternalMount] = {}
        # Desktop channel bridge for cloud external-only ops (per-op root_id).
        self._external_bridge: LocalWorkspace | None = None
        # Shared-space cloud second roots (``shared/<alias>/…``).
        self._shared_mounts: dict[str, SharedMount] = {}
        # Realtime membership gate: space_id → current mount mode, or None if gone.
        self._shared_gate: Callable[[str], Awaitable[SharedMountMode | None]] | None = None
        # Optional hook after a successful shared mutation (firehose / event log).
        self._on_shared_mutation: (
            Callable[[str, str, str], Awaitable[None]] | None
        ) = None  # (space_id, action, path)
        # Turn material paths for AI ``list_tree`` AI-noise reveal (∪ attachments/).
        # Set by prepare/wire from ``collect_turn_material_paths``; default empty.
        self.ai_list_materials: frozenset[str] = frozenset()
        # When True, AI list_tree / channel list keep archive suffixes visible
        # (file_list pattern targets zip/rar/…). Default False.
        self.ai_list_reveal_archives: bool = False
        # Once-per-backend exec-env probe (sidecar SubprocessSandbox).
        self._exec_env_probed: bool = False
        self._exec_env_alive: bool = True

    def set_lock_waiting_hook(self, hook: Callable[[bool], None] | None) -> None:
        """Register UX callback for contended mutation-lock waits (不得静默等锁)."""
        self._on_lock_waiting = hook

    @property
    def dirty(self) -> bool:
        return self._dirty

    def _mark_mutated(self) -> None:
        """Snapshot dirty + invalidate code index (schedule background refresh).

        Always routes through :meth:`start_code_index_maintenance` so the first
        write on a previously empty workspace still starts indexing (empty /
        internal-only trees are a no-op until non-internal content exists).
        """
        self._dirty = True
        if self._index_manager is not None:
            self._index_manager.mark_content_dirty()
        self.start_code_index_maintenance()

    def start_code_index_maintenance(self) -> None:
        """Kick coalesced background ensure (write / ``code_search`` / warm).

        Uses the process-wide maintainer for this root so sidecar turn backends
        and ``warmCodeIndex`` coalesce. Lazy B1: only when the workspace has
        non-internal content — empty chats must not ``mkdir AgentCore/index``
        (which would leak into hub has_files).
        """
        if not path_has_non_internal_entries(self._root):
            return
        self._get_index_manager()
        self._index_maintainer = shared_index_maintainer(self._root, self)
        self._index_maintainer.schedule()

    async def _release_code_index_for_tree_delete(self) -> None:
        """Abort maintenance + drop SQLite handles before removing ``AgentCore/index``.

        Windows cannot ``rmtree`` a SQLite file held open by a background ensure
        (WinError 32).
        """
        await drop_index_registry(self._root)
        self._index_manager = None
        self._index_maintainer = None

    def attach_external_mounts(self, mounts: dict[str, ExternalMount]) -> None:
        """Attach session-scoped external mounts for this turn (W3 / organize)."""
        self._mounts = dict(mounts)
        if self._external_bridge is not None:
            self._external_bridge.attach_external_mounts(self._mounts)

    def attach_external_channel(self, channel: WorkspaceChannel) -> None:
        """Attach a desktop channel for cloud ``external/`` ops (root_id only grants).

        Does not flip ``location`` — cloud workers stay ungated; desktop pathGuard +
        organize whitelist + plan card remain the authorization surface.
        """
        bridge = LocalWorkspace(channel, root_label=self.root_label)
        bridge.attach_external_mounts(self._mounts)
        self._external_bridge = bridge

    def attach_shared_mounts(
        self,
        mounts: dict[str, SharedMount],
        *,
        gate: Callable[[str], Awaitable[SharedMountMode | None]] | None = None,
        on_mutation: Callable[[str, str, str], Awaitable[None]] | None = None,
    ) -> None:
        """Attach session-scoped shared-space mounts (cloud second root)."""
        self._shared_mounts = dict(mounts)
        self._shared_gate = gate
        self._on_shared_mutation = on_mutation

    def _external_needs_channel(self, *paths: str) -> bool:
        """True when any path is ``external/`` without ``abs_path`` (desktop channel).

        Unknown aliases raise ``PathNotFound`` immediately. Paths with ``abs_path``
        (sidecar) stay on direct Path I/O.
        """
        needs = False
        for path in paths:
            if not is_external_namespace(path):
                continue
            routed = route_external(path, self._mounts)
            if routed is None:
                raise PathNotFound(path)
            if not routed.mount.abs_path:
                needs = True
        return needs

    def _require_external_bridge(self) -> LocalWorkspace:
        if self._external_bridge is None:
            raise WorkspaceIOError("会话授权目录在本机引擎外不可直读")
        return self._external_bridge

    @property
    def root(self) -> Path:
        """The server-side workspace directory (used by the snapshot path)."""
        return self._root

    async def _gate_shared(self, path: str, *, write: bool) -> None:
        """Realtime role check for ``shared/<alias>/…`` (tool-call granularity)."""
        if parse_shared_path(path) is None:
            return
        routed = route_shared(path, self._shared_mounts)
        if routed is None:
            raise PathNotFound(path)
        mode: SharedMountMode | None = routed.mount.mode
        if self._shared_gate is not None:
            mode = await self._shared_gate(routed.mount.space_id)
        if mode is None:
            raise OutsideWorkspace(revoked_error(path))
        if write and mode == "readonly":
            raise OutsideWorkspace(readonly_write_error(path))

    @asynccontextmanager
    async def _mutation_lock(self, path: str):
        """Single-layer lock for one mutating op (A′).

        Shared mounts serialize on the space key; primary tree uses ``lock_key``
        when set. Never nest with an outer same-key ``workspace_lock``.
        Contended waits notify ``_on_lock_waiting`` (honest SSE; 不得静默等锁).
        """
        routed = route_shared(path, self._shared_mounts) if parse_shared_path(path) else None
        if routed is not None:
            async with workspace_lock(
                shared_workspace_storage_key(routed.mount.space_id),
                on_waiting=self._on_lock_waiting,
            ):
                yield
            return
        if self._lock_key:
            async with workspace_lock(self._lock_key, on_waiting=self._on_lock_waiting):
                yield
            return
        yield

    async def _emit_shared_mutation(self, path: str, action: str) -> None:
        if self._on_shared_mutation is None or parse_shared_path(path) is None:
            return
        routed = route_shared(path, self._shared_mounts)
        if routed is None:
            return
        await self._on_shared_mutation(routed.mount.space_id, action, path)

    def _safe(
        self,
        rel: str,
        *,
        write: bool = False,
        op: str | None = None,
        permanent: bool = False,
    ) -> Path:
        shared_parsed = parse_shared_path(rel)
        if shared_parsed is not None:
            routed = route_shared(rel, self._shared_mounts)
            if routed is None:
                raise PathNotFound(rel)
            if write and routed.mount.mode == "readonly":
                # Sync fallback when gate wasn't awaited yet (should be gated first).
                raise OutsideWorkspace(readonly_write_error(rel))
            mount_root = shared_workspace_root_path(routed.mount.space_id)
            mount_root.mkdir(parents=True, exist_ok=True)
            mount_rel = routed.rel if routed.rel not in ("", ".") else "."
            resolved = resolve_safe_path(mount_root, mount_rel if mount_rel != "." else ".")
            if resolved is None:
                if mount_rel in ("", "."):
                    return mount_root.resolve()
                raise OutsideWorkspace(rel)
            return resolved
        if is_external_namespace(rel):
            routed = route_external(rel, self._mounts)
            if routed is None:
                raise PathNotFound(rel)
            if write:
                err = external_mutation_allowed(
                    routed.mount,
                    op or "write",
                    path=rel,
                    permanent=permanent,
                )
                if err:
                    raise OutsideWorkspace(err)
            if not routed.mount.abs_path:
                raise WorkspaceIOError("会话授权目录在本机引擎外不可直读")
            mount_root = Path(routed.mount.abs_path)
            mount_rel = routed.rel if routed.rel not in ("", ".") else "."
            # Same guard algorithm — separate root, not a weakened boundary.
            resolved = resolve_safe_path(mount_root, mount_rel if mount_rel != "." else ".")
            if resolved is None:
                # ``"."`` against root: resolve_safe_path(workspace, ".") → workspace
                if mount_rel in ("", "."):
                    return mount_root.resolve()
                raise OutsideWorkspace(rel)
            return resolved
        # Normalize model-supplied absolute root-label paths (``/workspace/x.md`` →
        # ``x.md``) at this single seam before the traversal guard runs — only inputs
        # the guard would already reject can be rescued; ``..`` / other-root paths
        # still fail (see strip_root_label_prefix).
        resolved = resolve_safe_path(self._root, rel, root_label=self.root_label)
        if resolved is None:
            raise OutsideWorkspace(rel)
        return resolved

    def _model_path(self, abs_path: Path, *, logical: str | None = None) -> str:
        """Map an absolute path back to a model-facing relative path.

        Prefer the caller's logical ``external/<alias>/…`` or ``shared/<alias>/…``
        namespace; if that fails (or is absent), reverse-lookup mounts by abs
        containment so a mount file never falls through to
        ``relpath(…, primary_root)`` which would leak ``../``-shaped paths into
        model-visible list/grep output.
        """
        resolved = abs_path.resolve()
        if logical and parse_shared_path(logical) is not None:
            routed = route_shared(logical, self._shared_mounts)
            if routed:
                mount_root = shared_workspace_root_path(routed.mount.space_id).resolve()
                try:
                    rel = resolved.relative_to(mount_root)
                    return shared_ns(routed.mount.alias, _posix(str(rel)))
                except ValueError:
                    pass
        if logical and parse_external_path(logical) is not None:
            routed = route_external(logical, self._mounts)
            if routed and routed.mount.abs_path:
                mount_root = Path(routed.mount.abs_path).resolve()
                try:
                    rel = resolved.relative_to(mount_root)
                    return external_ns(routed.mount.alias, _posix(str(rel)))
                except ValueError:
                    pass
        for mount in self._shared_mounts.values():
            mount_root = shared_workspace_root_path(mount.space_id).resolve()
            try:
                rel = resolved.relative_to(mount_root)
                return shared_ns(mount.alias, _posix(str(rel)))
            except ValueError:
                continue
        for mount in self._mounts.values():
            if not mount.abs_path:
                continue
            mount_root = Path(mount.abs_path).resolve()
            try:
                rel = resolved.relative_to(mount_root)
                return external_ns(mount.alias, _posix(str(rel)))
            except ValueError:
                continue
        return _posix(os.path.relpath(resolved, self._root.resolve()))

    def _get_index_manager(self) -> IndexManager:
        if self._index_manager is None:
            self._index_manager = shared_index_manager(self._root)
        return self._index_manager

    def _reject_oversized_file(self, target: Path) -> None:
        """Capacity contract: refuse whole-file loads above ``WORKSPACE_READ_MAX_BYTES``.

        Same detail string as desktop Local so the tool layer can mark ``contract_failure``.
        """
        try:
            size = target.stat().st_size
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e
        if size > WORKSPACE_READ_MAX_BYTES:
            raise WorkspaceIOError(FILE_TOO_LARGE_DETAIL)

    async def read(self, path: str) -> str:
        if self._external_needs_channel(path):
            return await self._require_external_bridge().read(path)
        await self._gate_shared(path, write=False)
        target = self._safe(path)
        if not target.exists():
            raise PathNotFound(path)
        if not target.is_file():
            raise NotAFile(path)
        self._reject_oversized_file(target)
        try:
            return target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            raise WorkspaceIOError(str(e)) from e

    async def write(self, path: str, content: str) -> int:
        if self._external_needs_channel(path):
            n = await self._require_external_bridge().write(path, content)
            self._mark_mutated()
            return n
        async with self._mutation_lock(path):
            await self._gate_shared(path, write=True)
            target = self._safe(path, write=True, op="write")
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            except OSError as e:
                raise WorkspaceIOError(str(e)) from e
            self._mark_mutated()
            await self._emit_shared_mutation(path, "file_written")
            return len(content)

    async def append(self, path: str, content: str) -> int:
        if self._external_needs_channel(path):
            n = await self._require_external_bridge().append(path, content)
            self._mark_mutated()
            return n
        async with self._mutation_lock(path):
            await self._gate_shared(path, write=True)
            target = self._safe(path, write=True, op="append")
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    if not target.is_file():
                        raise NotAFile(path)
                    with target.open("a", encoding="utf-8") as fh:
                        fh.write(content)
                else:
                    target.write_text(content, encoding="utf-8")
            except NotAFile:
                raise
            except OSError as e:
                raise WorkspaceIOError(str(e)) from e
            self._mark_mutated()
            await self._emit_shared_mutation(path, "file_written")
            return len(content)

    async def resolve_for_download(self, path: str, *, max_bytes: int) -> Path:
        """Resolve a on-disk path for HTTP panel download (``FileResponse``).

        Capacity is ``max_bytes`` (aligned with upload), **not** the AI-tool
        ``WORKSPACE_READ_MAX_BYTES`` gate used by :meth:`read` / :meth:`read_bytes`.
        Does not load file contents into memory.
        """
        if self._external_needs_channel(path):
            raise WorkspaceIOError("会话授权目录在本机引擎外不可直读")
        await self._gate_shared(path, write=False)
        target = self._safe(path)
        if not target.exists():
            raise PathNotFound(path)
        if not target.is_file():
            raise NotAFile(path)
        try:
            size = target.stat().st_size
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e
        if size > max_bytes:
            raise WorkspaceIOError(FILE_TOO_LARGE_DETAIL)
        return target

    async def read_bytes(self, path: str) -> bytes:
        if self._external_needs_channel(path):
            return await self._require_external_bridge().read_bytes(path)
        await self._gate_shared(path, write=False)
        target = self._safe(path)
        if not target.exists():
            raise PathNotFound(path)
        if not target.is_file():
            raise NotAFile(path)
        self._reject_oversized_file(target)
        try:
            return target.read_bytes()
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e

    async def write_bytes(self, path: str, data: bytes) -> int:
        if self._external_needs_channel(path):
            n = await self._require_external_bridge().write_bytes(path, data)
            self._mark_mutated()
            return n
        async with self._mutation_lock(path):
            await self._gate_shared(path, write=True)
            target = self._safe(path, write=True, op="write_bytes")
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write_bytes(target, data)
            except OSError as e:
                raise WorkspaceIOError(str(e)) from e
            self._mark_mutated()
            await self._emit_shared_mutation(path, "file_written")
            return len(data)

    async def read_for_edit(self, path: str) -> tuple[str, int, Literal["lf", "crlf"]]:
        """Read a text file for in-panel editing: ``(text, mtime_ms, eol)``.

        Unlike the preview download (truncated), this returns the **whole** file so
        a later save never drops the tail. Content is newline-normalized to ``\\n``;
        the original EOL is reported so the editor can restore it on write.
        ``mtime_ms`` is the write-time CAS baseline (see :meth:`write_text_cas`).
        Raises ``OutsideWorkspace`` / ``PathNotFound`` / ``NotAFile`` / ``NotUTF8`` /
        ``WorkspaceIOError``.
        """
        await self._gate_shared(path, write=False)
        target = self._safe(path)
        if not target.exists():
            raise PathNotFound(path)
        if not target.is_file():
            raise NotAFile(path)
        self._reject_oversized_file(target)
        try:
            raw = target.read_bytes()
            mtime_ms = target.stat().st_mtime_ns // 1_000_000
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as e:
            raise NotUTF8(path) from e
        eol: Literal["lf", "crlf"] = "crlf" if "\r\n" in text else "lf"
        return text.replace("\r\n", "\n"), mtime_ms, eol

    async def write_text_cas(
        self,
        path: str,
        content: str,
        *,
        baseline_mtime_ms: int,
        eol: Literal["lf", "crlf"],
    ) -> tuple[bool, int]:
        """Conditionally write ``content`` with a write-time CAS on mtime.

        Returns ``(ok, mtime_ms)``: on success ``mtime_ms`` is the new mtime; on a
        **conflict** (``ok`` is False) it is the current disk mtime, so the caller can
        offer "overwrite anyway" using it as the next baseline — we never blind-clobber
        a file changed under us (e.g. by an Agent turn). ``baseline_mtime_ms == 0``
        means "new file": a conflict if something already exists at ``path``. ``\\n``
        is restored to ``eol`` before an atomic (temp + rename) write. Raises
        ``OutsideWorkspace`` / ``NotAFile`` / ``WorkspaceIOError``.

        Best-effort against external writers; this method holds ``workspace_lock``
        (via ``lock_key`` / shared space key) for the CAS so an Agent write can't
        interleave mid-check — callers must not nest another same-key hold.
        """
        async with self._mutation_lock(path):
            await self._gate_shared(path, write=True)
            target = self._safe(path, write=True, op="write")
            exists = target.exists()
            if exists and not target.is_file():
                raise NotAFile(path)
            try:
                if baseline_mtime_ms == 0:
                    if exists:
                        return False, target.stat().st_mtime_ns // 1_000_000
                elif not exists:
                    return False, 0  # the baseline file was deleted under us
                else:
                    disk_ms = target.stat().st_mtime_ns // 1_000_000
                    if disk_ms != baseline_mtime_ms:
                        return False, disk_ms
                body = content.replace("\n", "\r\n") if eol == "crlf" else content
                target.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write_bytes(target, body.encode("utf-8"))
                new_ms = target.stat().st_mtime_ns // 1_000_000
            except OSError as e:
                raise WorkspaceIOError(str(e)) from e
            self._mark_mutated()
            await self._emit_shared_mutation(path, "file_written")
            return True, new_ms

    async def list(self, directory: str, pattern: str) -> list[DirEntry]:
        if self._external_needs_channel(directory):
            bridge = self._require_external_bridge()
            bridge.ai_list_reveal_archives = self.ai_list_reveal_archives
            return await bridge.list(directory, pattern)
        await self._gate_shared(directory, write=False)
        base = self._safe(directory)
        if not base.is_dir():
            # Declared stage / attachments trees: writes mkdir parents — missing
            # means latent empty, not a guess failure. File-at-path still errors.
            if not base.exists() and is_declared_latent_dir(directory):
                return []
            raise NotADirectory(directory)
        try:
            entries = sorted(base.glob(pattern))[:_MAX_LIST_ENTRIES]
            out: list[DirEntry] = []
            for entry in entries:
                # Per-entry parent — recursive ``**/*`` yields nested paths; using the
                # list-root as parent_rel would treat ``AgentCore/index`` as bare
                # ``index`` and leak internal zones into the user file UI.
                entry_rel = self._model_path(entry, logical=directory).replace(
                    "\\", "/"
                ).strip("/")
                if not entry_rel or entry_rel == ".":
                    continue
                if "/" in entry_rel:
                    parent_rel, entry_name = entry_rel.rsplit("/", 1)
                else:
                    parent_rel, entry_name = "", entry_rel
                # Name-first ignore — avoid touching locked noise dirs (e.g. Windows
                # ``.pytest_tmp``) before ``is_dir`` / ``is_file``.
                if is_ignored_dir_entry(parent_rel=parent_rel, name=entry_name):
                    continue
                try:
                    is_dir = entry.is_dir()
                    is_file = entry.is_file()
                except OSError as e:
                    if is_access_denied_oserror(e):
                        continue
                    raise WorkspaceIOError(str(e)) from e
                if is_file and is_system_ignored_file_name(entry_name):
                    continue
                # Soft meta for UI subtitles — never fail the whole listing on stat.
                size_bytes: int | None = None
                mtime_ms: int | None = None
                try:
                    st = entry.stat()
                    mtime_ms = st.st_mtime_ns // 1_000_000
                    if not is_dir:
                        size_bytes = int(st.st_size)
                except OSError:
                    pass
                # UI REST shares ``list`` — only system noise; AI ``file_list``
                # applies AI-noise filtering in the tool layer.
                out.append(
                    DirEntry(
                        path=entry_rel,
                        is_dir=is_dir,
                        size_bytes=size_bytes,
                        mtime_ms=mtime_ms,
                    )
                )
            return out
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e

    async def exists(self, path: str) -> bool:
        """True iff ``path`` is an existing regular file (unfiltered by AI-noise)."""
        if self._external_needs_channel(path):
            return await self._require_external_bridge().exists(path)
        await self._gate_shared(path, write=False)
        target = self._safe(path)
        try:
            return target.is_file()
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e

    async def read_lines(
        self, path: str, *, offset: int = 1, limit: int | None = None
    ) -> ReadLinesResult:
        if self._external_needs_channel(path):
            return await self._require_external_bridge().read_lines(
                path, offset=offset, limit=limit
            )
        target = self._safe(path)
        if not target.exists():
            raise PathNotFound(path)
        if not target.is_file():
            raise NotAFile(path)
        self._reject_oversized_file(target)
        try:
            content = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            raise WorkspaceIOError(str(e)) from e

        lines = content.splitlines()
        total = len(lines)
        start_idx = max(0, offset - 1)
        if start_idx >= total:
            return ReadLinesResult(
                lines=[],
                start_line=offset,
                end_line=offset - 1,
                total_lines=total,
            )

        end_idx = total if limit is None else min(total, start_idx + limit)
        selected = lines[start_idx:end_idx]
        return ReadLinesResult(
            lines=selected,
            start_line=start_idx + 1,
            end_line=end_idx,
            total_lines=total,
        )

    async def list_tree(
        self,
        directory: str,
        *,
        pattern: str = "*",
        max_depth: int = 3,
        max_entries: int = 200,
    ) -> TreeResult:
        if self._external_needs_channel(directory):
            bridge = self._require_external_bridge()
            bridge.ai_list_reveal_archives = self.ai_list_reveal_archives
            return await bridge.list_tree(
                directory,
                pattern=pattern,
                max_depth=max_depth,
                max_entries=max_entries,
            )
        base = self._safe(directory)
        if not base.is_dir():
            if not base.exists() and is_declared_latent_dir(directory):
                return TreeResult(entries=[], truncated=False, elided_count=0)
            raise NotADirectory(directory)

        entries: list[TreeEntry] = []
        truncated = False
        elided_count = 0
        warnings: list[str] = []
        name_filter = pattern or "*"
        reveal_archives = self.ai_list_reveal_archives

        def walk(dir_path: Path, depth: int, *, is_root: bool) -> None:
            nonlocal truncated, elided_count
            if depth > max_depth:
                return
            try:
                children = sorted(dir_path.iterdir(), key=lambda p: p.name.lower())
            except OSError as e:
                if not is_root and is_access_denied_oserror(e):
                    try:
                        rel = dir_path.resolve().relative_to(self._root.resolve()).as_posix()
                    except ValueError:
                        rel = self._model_path(dir_path, logical=directory)
                    if rel == ".":
                        rel = directory if directory not in ("", ".") else "."
                    warnings.append(f"跳过无权限目录：{rel}")
                    return
                raise WorkspaceIOError(str(e)) from e

            # Prefer model-facing ``external/<alias>/…`` (or shared) when the
            # list root is in that namespace — mount abs may sit under the
            # primary tree in tests / edge layouts, which would otherwise hide
            # archives as workspace AI-noise.
            if parse_external_path(directory) is not None or parse_shared_path(
                directory
            ) is not None:
                parent_rel = self._model_path(dir_path, logical=directory)
            else:
                try:
                    parent_rel = dir_path.resolve().relative_to(
                        self._root.resolve()
                    ).as_posix()
                except ValueError:
                    parent_rel = self._model_path(dir_path, logical=directory)
            if parent_rel in (".", ""):
                parent_rel = ""
            elif parent_rel.endswith("/."):
                parent_rel = parent_rel[:-2]

            for child in children:
                # Name-first prune — do not ``is_dir`` locked ignore-set dirs.
                if is_ignored_dir_entry(parent_rel=parent_rel, name=child.name):
                    continue
                try:
                    is_dir = child.is_dir() and not child.is_symlink()
                    is_file = child.is_file()
                except OSError as e:
                    if is_access_denied_oserror(e):
                        rel = f"{parent_rel}/{child.name}" if parent_rel else child.name
                        warnings.append(f"跳过无权限条目：{rel}")
                        continue
                    raise WorkspaceIOError(str(e)) from e

                # AI list_tree: system noise always; AI noise except attachments/
                # materials; archives under external/ or reveal_archives.
                if is_file and is_ai_list_hidden_file(
                    parent_rel=parent_rel,
                    name=child.name,
                    materials=self.ai_list_materials,
                    reveal_archives=reveal_archives,
                ):
                    continue

                rel = self._model_path(child, logical=directory)

                if not is_dir and not fnmatch.fnmatch(child.name, name_filter):
                    continue

                if len(entries) >= max_entries:
                    truncated = True
                    elided_count += 1
                    continue

                entries.append(TreeEntry(path=rel, is_dir=is_dir, depth=depth))
                if is_dir and depth < max_depth:
                    walk(child, depth + 1, is_root=False)

        walk(base, 1, is_root=True)
        return TreeResult(
            entries=entries,
            truncated=truncated,
            elided_count=elided_count,
            warnings=warnings,
        )

    async def index_files(
        self, cap: int | None = None, *, order: str = "path"
    ) -> IndexFilesResult:
        """Flat list of file paths for @ mentions (文件中枢统一 F4) + worker manifest.

        Files only, ``IGNORED_DIRS`` pruned, capped at ``cap`` (``truncated`` when
        hit; ``cap=None`` uses the default ``_MAX_INDEX_FILES``) — the cloud
        counterpart to the desktop ``fsApi.listFiles`` that indexes local roots, so @
        and the worker manifest behave the same whether a workspace is cloud or local.
        ``order="path"`` (default) = alphabetical (the @ view); ``order="recent"`` =
        newest-first by mtime for the manifest's relevance budget.
        Each entry carries local-stat ``mtime_ms`` / ``size_bytes`` so
        ``ensure_index`` can skip unchanged-file reads (same fingerprint contract
        as desktop ``index_files``).
        Noise dirs (``.git`` / ``node_modules`` / …) plus path-aware
        ``AgentCore/{index,trash,baselines}``, and AI-tier
        suffixes (``*.db`` / media / binaries) are pruned — same rule set as
        desktop ``collectWorkspaceFiles`` / ``opIndexFiles``.

        Disk walk runs in a worker thread (``asyncio.to_thread``) so a large
        tree does not stall the event-loop turn cycle.
        """
        cap = cap or _MAX_INDEX_FILES
        recent = order == "recent"
        root = self._root.resolve()
        return await asyncio.to_thread(
            _collect_index_files_sync, root, cap=cap, recent=recent
        )

    async def mkdir(self, path: str) -> None:
        if self._external_needs_channel(path):
            await self._require_external_bridge().mkdir(path)
            self._mark_mutated()
            return
        async with self._mutation_lock(path):
            await self._gate_shared(path, write=True)
            target = self._safe(path, write=True, op="mkdir")
            # Refuse mkdir of the primary workspace root itself; external mount roots
            # are also "already there" as the grant target.
            if target == self._root.resolve():
                raise OutsideWorkspace(path)
            routed = route_external(path, self._mounts) if parse_external_path(path) else None
            if (
                routed
                and routed.mount.abs_path
                and target == Path(routed.mount.abs_path).resolve()
            ):
                raise OutsideWorkspace(path)
            shared = route_shared(path, self._shared_mounts) if parse_shared_path(path) else None
            if shared and target == shared_workspace_root_path(shared.mount.space_id).resolve():
                raise OutsideWorkspace(path)
            if target.exists():
                raise AlreadyExists(path)
            try:
                target.mkdir(parents=True, exist_ok=False)
            except OSError as e:
                raise WorkspaceIOError(str(e)) from e
            self._mark_mutated()
            await self._emit_shared_mutation(path, "dir_created")

    async def delete(self, path: str, *, permanent: bool = False) -> None:
        if self._external_needs_channel(path):
            await self._require_external_bridge().delete(path, permanent=permanent)
            self._mark_mutated()
            return
        async with self._mutation_lock(path):
            await self._gate_shared(path, write=True)
            target = self._safe(path, write=True, op="delete", permanent=permanent)
            if target == self._root.resolve():
                raise OutsideWorkspace(path)  # never delete the workspace root
            routed = route_external(path, self._mounts) if parse_external_path(path) else None
            if routed and routed.mount.abs_path:
                mount_root = Path(routed.mount.abs_path).resolve()
                if target == mount_root:
                    raise OutsideWorkspace(path)
            else:
                shared = (
                    route_shared(path, self._shared_mounts)
                    if parse_shared_path(path)
                    else None
                )
                if shared:
                    mount_root = shared_workspace_root_path(shared.mount.space_id).resolve()
                    if target == mount_root:
                        raise OutsideWorkspace(path)
                else:
                    mount_root = self._root.resolve()
            if not target.exists():
                raise PathNotFound(path)
            # Soft-delete into AgentCore/trash cannot nest under itself; treat
            # internal zones (index/trash/baselines) as permanent cleanup — not
            # the whole AgentCore/ tree (rules/memory/docs stay soft-deletable).
            # When target is an ancestor of trash (e.g. bare AgentCore/), expand
            # by children instead of moving the whole tree into itself.
            hard = permanent or is_internal_zone_path(path)
            # Expanding AgentCore/ (or hard-clearing index/) must release the
            # process-wide BM25 handle first — otherwise Windows shares-locks
            # ``code_search.db`` and the delete returns 422 mid-flight ensure.
            will_clear_index = hard and is_internal_zone_path(path) and (
                path.replace("\\", "/").rstrip("/") == "AgentCore/index"
                or path.replace("\\", "/").startswith("AgentCore/index/")
            )
            will_expand_agentcore = (not hard) and trash_dest_under_target(
                root=mount_root, target=target
            )
            if will_clear_index or will_expand_agentcore:
                await self._release_code_index_for_tree_delete()
            try:
                if hard:
                    if target.is_dir():
                        shutil.rmtree(target)
                    else:
                        target.unlink()
                elif trash_dest_under_target(root=mount_root, target=target):
                    soft_delete_expanding_trash_ancestor(
                        root=mount_root, target=target
                    )
                else:
                    shared_routed = (
                        route_shared(path, self._shared_mounts)
                        if parse_shared_path(path)
                        else None
                    )
                    trash_rel = (
                        routed.rel
                        if routed is not None
                        else (
                            shared_routed.rel
                            if shared_routed is not None
                            else path.replace("\\", "/")
                        )
                    )
                    soft_delete_to_trash(
                        root=mount_root,
                        target=target,
                        original_rel=trash_rel or path.replace("\\", "/"),
                    )
            except OSError as e:
                raise WorkspaceIOError(str(e)) from e
            self._mark_mutated()
            await self._emit_shared_mutation(path, "file_deleted")

    async def copy(self, src: str, dst: str) -> None:
        if self._external_needs_channel(src, dst):
            await self._require_external_bridge().copy(src, dst)
            self._mark_mutated()
            return
        async with self._mutation_lock(dst):
            await self._gate_shared(src, write=False)
            await self._gate_shared(dst, write=True)
            source = self._safe(src, write=False)
            dest = self._safe(dst, write=True, op="copy")
            src_ext = parse_external_path(src)
            dst_ext = parse_external_path(dst)
            if bool(src_ext) != bool(dst_ext):
                raise OutsideWorkspace("不能跨会话授权目录与工作区复制文件")
            if src_ext and dst_ext and src_ext[0] != dst_ext[0]:
                raise OutsideWorkspace("不能跨会话授权目录复制文件")
            if src_ext is None:
                root = self._root.resolve()
                if source == root or dest == root:
                    raise OutsideWorkspace(src if source == root else dst)
            if not source.exists():
                raise PathNotFound(src)
            if dest.exists():
                raise AlreadyExists(dst)
            # Refuse copying a directory into itself or a descendant (self-recursion).
            try:
                dest.relative_to(source)
                if source.is_dir():
                    raise WorkspaceIOError("不能复制到自身或其子目录")
            except ValueError:
                pass  # dest is not under source — expected
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                if source.is_dir():
                    shutil.copytree(source, dest)
                else:
                    shutil.copy2(source, dest)
            except OSError as e:
                raise WorkspaceIOError(str(e)) from e
            self._mark_mutated()
            await self._emit_shared_mutation(dst, "file_written")

    async def move(self, src: str, dst: str) -> None:
        if self._external_needs_channel(src, dst):
            await self._require_external_bridge().move(src, dst)
            self._mark_mutated()
            return
        async with self._mutation_lock(dst):
            await self._gate_shared(src, write=True)
            await self._gate_shared(dst, write=True)
            source = self._safe(src, write=True, op="move")
            dest = self._safe(dst, write=True, op="move")
            src_ext = parse_external_path(src)
            dst_ext = parse_external_path(dst)
            if bool(src_ext) != bool(dst_ext):
                raise OutsideWorkspace("不能跨会话授权目录与工作区移动文件")
            if src_ext and dst_ext and src_ext[0] != dst_ext[0]:
                raise OutsideWorkspace("不能跨会话授权目录移动文件")
            if src_ext is None:
                root = self._root.resolve()
                if source == root or dest == root:
                    raise OutsideWorkspace(src if source == root else dst)
            if not source.exists():
                raise PathNotFound(src)
            if dest.exists():
                raise AlreadyExists(dst)
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                os.replace(source, dest)
            except OSError as e:
                raise WorkspaceIOError(str(e)) from e
            self._mark_mutated()
            await self._emit_shared_mutation(dst, "file_moved")

    async def replace(self, path: str, old: str, new: str, *, all_: bool) -> ReplaceOutcome:
        if self._external_needs_channel(path):
            outcome = await self._require_external_bridge().replace(
                path, old, new, all_=all_
            )
            self._mark_mutated()
            return outcome
        async with self._mutation_lock(path):
            await self._gate_shared(path, write=True)
            target = self._safe(path, write=True, op="replace")
            if not target.exists():
                raise PathNotFound(path)
            if not target.is_file():
                raise NotAFile(path)

            try:
                # Read bytes + decode (no newline translation). ``apply_text_replace``
                # keeps exact hits byte-faithful; CRLF↔LF mismatch uses the LF-normalize
                # fallback and restores the file's original eol on write-back.
                content = target.read_bytes().decode("utf-8")
            except UnicodeDecodeError as e:
                raise NotUTF8(path) from e
            except OSError as e:
                raise WorkspaceIOError(str(e)) from e

            result = apply_text_replace(content, old, new, all_=all_)
            if isinstance(result, TextReplaceNoMatch):
                raise NoMatch(path)
            if isinstance(result, TextReplaceAmbiguous):
                raise AmbiguousMatch(result.count)

            try:
                _atomic_write_bytes(target, result.content.encode("utf-8"))
            except OSError as e:
                raise WorkspaceIOError(str(e)) from e

            self._mark_mutated()
            await self._emit_shared_mutation(path, "file_written")
            return ReplaceOutcome(count=result.count, first_line=result.first_line)

    async def grep(self, query: GrepQuery) -> GrepResult:
        # Path checks stay on the event loop so OutsideWorkspace / PathNotFound
        # surface immediately. The ripgrep child is awaited with
        # ``create_subprocess_exec`` so a tool-level ``asyncio.wait_for`` /
        # cancellation can kill the process (no silent Python walk fallback).
        if self._external_needs_channel(query.directory):
            return await self._require_external_bridge().grep(query)
        base = self._safe(query.directory)
        if not base.exists():
            raise PathNotFound(query.directory)
        logical = query.directory
        return await run_grep_rg(
            query=query,
            search_root=base,
            workspace_root=self._root,
            model_path=lambda p: self._model_path(p, logical=logical),
        )

    async def code_search(
        self,
        query: str,
        *,
        language: str | None = None,
        path_prefix: str = ".",
        max_results: int = 10,
    ) -> CodeSearchResult:
        manager = self._get_index_manager()
        return await manager.search(
            query,
            language=language,
            path_prefix=path_prefix,
            max_results=max_results,
        )

    async def ensure_code_index(self, *, force: bool = False) -> bool:
        manager = self._get_index_manager()
        return await manager.ensure_index(self, force=force)

    async def diagnostics(self, paths: list[str]) -> dict:
        """Cloud has no language-service channel — honest unavailable (no fake tsc)."""
        _ = paths
        return {
            "status": "unavailable",
            "reason": "云端工作区暂不支持语言服务内环诊断",
            "diagnostics": [],
        }

    async def execute(self, req: ExecutionRequest) -> ExecutionResult:
        # Run code in the workspace root so relative file paths resolve against
        # the same files the file tools see.
        #
        # Mark dirty conservatively: the backend can't introspect what the
        # sandbox wrote, and executed code commonly produces artifacts in the
        # workspace, so we treat any run as potentially mutating. The cost is an
        # occasional snapshot of a pure-compute run (cheap, async, post-answer);
        # the alternative — silently missing code-generated files — is worse for
        # a backup feature. Read-only file ops still never set this.
        #
        # A′: hold the same single-layer mutation lock as file writes for the
        # whole sandbox run (code_execute / test_run). Whole-turn lock used to
        # cover this; without it, execute would race sibling turns' writes.
        async with self._mutation_lock("."):
            from agentcore.tools.sandbox.exec_env import probe_failure_result

            if not self._exec_env_probed:
                self._exec_env_probed = True
                try:
                    self._exec_env_alive = bool(await self._sandbox.health_check())
                except Exception:
                    self._exec_env_alive = False
                    from agentcore.core.logging import get_logger

                    get_logger(__name__).info(
                        "sandbox.health_check_failed",
                        error="health_check raised",
                        location=self.location,
                    )
                if not self._exec_env_alive:
                    from agentcore.core.logging import get_logger

                    # Carry the sandbox's own failure reason — the sticky marker
                    # returned to the model is deliberately opaque, so without this
                    # a dead exec env leaves no way to tell timeout from missing
                    # interpreter from AV interference.
                    failure = getattr(self._sandbox, "last_health_failure", None)
                    reason, detail = failure if failure else (None, None)
                    get_logger(__name__).info(
                        "sandbox.exec_env_probe_failed",
                        location=self.location,
                        reason=reason,
                        detail=detail,
                    )
                    return probe_failure_result()
            elif not self._exec_env_alive:
                return probe_failure_result()
            self._mark_mutated()
            env = dict(req.env or {})
            env.update(build_external_env(self._mounts))
            cwd = str(self._root.resolve())
            # D11′：python 执行与 TestExitCode 同源注入 PYTHONPATH（. + 现存 src/lib）
            if req.language == "python":
                from agentcore.tools.sandbox.pythonpath import merge_pythonpath_into_env

                env = merge_pythonpath_into_env(Path(cwd), env)
            return await self._sandbox.execute(
                replace(req, cwd=cwd, env=env or None)
            )
