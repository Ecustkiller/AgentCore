"""ServerWorkspace — files and code execution on the server (cloud mode).

The first ``WorkspaceBackend`` implementation. It owns a root directory on the
server and a ``SandboxProvider`` for code execution. All filesystem operations
resolve through ``resolve_safe_path`` (the traversal guard, now internal to the
backend), and ``execute`` delegates to the sandbox with ``cwd`` set to the root
so executed code sees the workspace files — fixing the long-standing bug where
``code_execute`` ran in a throwaway temp dir disconnected from file tools.
"""

from __future__ import annotations

import contextlib
import fnmatch
import os
import re
import shutil
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Literal

from agentcore.tools.sandbox.protocol import (
    ExecutionRequest,
    ExecutionResult,
    SandboxProvider,
)
from agentcore.workspace._paths import (
    IGNORED_DIRS,
    normalize_glob,
    read_text_file,
    resolve_safe_path,
)
from agentcore.workspace.protocol import (
    AlreadyExists,
    AmbiguousMatch,
    DirEntry,
    GrepHit,
    GrepQuery,
    GrepResult,
    NoMatch,
    NotADirectory,
    NotAFile,
    NotUTF8,
    OutsideWorkspace,
    PathNotFound,
    ReplaceOutcome,
    WorkspaceIOError,
)

_MAX_LIST_ENTRIES = 100
_MAX_LINE_LEN = 300  # trim very long matching lines (e.g. minified bundles)
_MAX_FILES_SCANNED = 5000  # bound total files opened per grep call
_MAX_RESULTS_CAP = 200
_MAX_INDEX_FILES = 5000  # @ mention flat index cap (mirrors desktop LIST_FILES_CAP)


def _posix(rel: str) -> str:
    return rel.replace(os.sep, "/")


def _trim(line: str) -> str:
    s = line.strip()
    return s[:_MAX_LINE_LEN] + " …" if len(s) > _MAX_LINE_LEN else s


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
    (see ``delegate.py`` worker_gate, ``pipeline.py`` revise_gate). The op surface is
    identical either way (direct ``Path`` access; never a ``WorkspaceChannel``
    round-trip — that is ``LocalWorkspace``'s job).
    """

    def __init__(
        self,
        root: Path,
        sandbox: SandboxProvider,
        *,
        root_label: str = "workspace",
        location: Literal["server", "local"] = "server",
    ) -> None:
        self._root = root
        self._sandbox = sandbox
        self.root_label = root_label
        self.location: Literal["server", "local"] = location
        # Flips True on the first mutating op so the service snapshots only
        # workspaces a turn actually changed (see WorkspaceBackend.dirty).
        self._dirty = False

    @property
    def dirty(self) -> bool:
        return self._dirty

    @property
    def root(self) -> Path:
        """The server-side workspace directory (used by the snapshot path)."""
        return self._root

    def _safe(self, rel: str) -> Path:
        resolved = resolve_safe_path(self._root, rel)
        if resolved is None:
            raise OutsideWorkspace(rel)
        return resolved

    async def read(self, path: str) -> str:
        target = self._safe(path)
        if not target.exists():
            raise PathNotFound(path)
        if not target.is_file():
            raise NotAFile(path)
        try:
            return target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            raise WorkspaceIOError(str(e)) from e

    async def write(self, path: str, content: str) -> int:
        target = self._safe(path)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e
        self._dirty = True
        return len(content)

    async def read_bytes(self, path: str) -> bytes:
        target = self._safe(path)
        if not target.exists():
            raise PathNotFound(path)
        if not target.is_file():
            raise NotAFile(path)
        try:
            return target.read_bytes()
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e

    async def write_bytes(self, path: str, data: bytes) -> int:
        target = self._safe(path)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write_bytes(target, data)
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e
        self._dirty = True
        return len(data)

    async def read_for_edit(
        self, path: str
    ) -> tuple[str, int, Literal["lf", "crlf"]]:
        """Read a text file for in-panel editing: ``(text, mtime_ms, eol)``.

        Unlike the preview download (truncated), this returns the **whole** file so
        a later save never drops the tail. Content is newline-normalized to ``\\n``;
        the original EOL is reported so the editor can restore it on write.
        ``mtime_ms`` is the write-time CAS baseline (see :meth:`write_text_cas`).
        Raises ``OutsideWorkspace`` / ``PathNotFound`` / ``NotAFile`` / ``NotUTF8`` /
        ``WorkspaceIOError``.
        """
        target = self._safe(path)
        if not target.exists():
            raise PathNotFound(path)
        if not target.is_file():
            raise NotAFile(path)
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

        Best-effort against external writers; callers serialize against same-workspace
        turns via ``workspace_lock`` so an Agent write can't interleave mid-CAS.
        """
        target = self._safe(path)
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
        self._dirty = True
        return True, new_ms

    async def list(self, directory: str, pattern: str) -> list[DirEntry]:
        base = self._safe(directory)
        if not base.is_dir():
            raise NotADirectory(directory)
        try:
            entries = sorted(base.glob(pattern))[:_MAX_LIST_ENTRIES]
            return [
                DirEntry(
                    path=_posix(os.path.relpath(entry, self._root)),
                    is_dir=entry.is_dir(),
                )
                for entry in entries
            ]
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e

    async def index_files(self, cap: int = _MAX_INDEX_FILES) -> tuple[list[str], bool]:
        """Flat list of file paths for @ mentions (文件中枢统一 F4).

        Files only, ``IGNORED_DIRS`` pruned, capped at ``cap`` (``truncated`` when
        hit) — the cloud counterpart to the desktop ``fsApi.listFiles`` that indexes
        local roots, so @ behaves the same whether a workspace is cloud or local.
        Binary/oversized files are *not* filtered here (mirroring local): the read
        step applies that when a file is actually attached.
        """
        root = self._root.resolve()
        paths: list[str] = []
        truncated = False
        for dirpath, dirnames, filenames in os.walk(root):
            # Prune noise dirs in place so os.walk never descends into them.
            dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
            for fname in sorted(filenames):
                full = Path(dirpath) / fname
                if full.is_symlink() or not full.is_file():
                    continue
                paths.append(_posix(os.path.relpath(full, root)))
                if len(paths) >= cap:
                    truncated = True
                    break
            if truncated:
                break
        paths.sort()
        return paths, truncated

    async def mkdir(self, path: str) -> None:
        target = self._safe(path)
        if target == self._root.resolve():
            raise OutsideWorkspace(path)  # the root already exists
        if target.exists():
            raise AlreadyExists(path)
        try:
            target.mkdir(parents=True, exist_ok=False)
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e
        self._dirty = True

    async def delete(self, path: str) -> None:
        target = self._safe(path)
        if target == self._root.resolve():
            raise OutsideWorkspace(path)  # never delete the workspace root
        if not target.exists():
            raise PathNotFound(path)
        try:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e
        self._dirty = True

    async def move(self, src: str, dst: str) -> None:
        source = self._safe(src)
        dest = self._safe(dst)
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
        self._dirty = True

    async def replace(
        self, path: str, old: str, new: str, *, all_: bool
    ) -> ReplaceOutcome:
        target = self._safe(path)
        if not target.exists():
            raise PathNotFound(path)
        if not target.is_file():
            raise NotAFile(path)

        try:
            # Read bytes + decode (no newline translation) so existing line
            # endings survive the write-back byte-for-byte.
            content = target.read_bytes().decode("utf-8")
        except UnicodeDecodeError as e:
            raise NotUTF8(path) from e
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e

        count = content.count(old)
        if count == 0:
            raise NoMatch(path)
        if count > 1 and not all_:
            raise AmbiguousMatch(count)

        if all_:
            new_content = content.replace(old, new)
            first_line: int | None = None
        else:
            new_content = content.replace(old, new, 1)
            first_line = content[: content.find(old)].count("\n") + 1

        try:
            _atomic_write_bytes(target, new_content.encode("utf-8"))
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e

        self._dirty = True
        return ReplaceOutcome(count=count if all_ else 1, first_line=first_line)

    async def grep(self, query: GrepQuery) -> GrepResult:
        base = self._safe(query.directory)
        if not base.exists():
            raise PathNotFound(query.directory)

        flags = re.IGNORECASE if query.case_insensitive else 0
        regex = re.compile(query.pattern, flags)
        max_results = max(1, min(query.max_results, _MAX_RESULTS_CAP))
        result = GrepResult()

        # ``directory`` may name a single file (rg PATTERN FILE muscle memory):
        # scan just that file, no walk. ``glob`` is moot — the file is pinpointed.
        if base.is_file():
            self._grep_one_file(
                base, regex, result, files_only=query.files_only, max_results=max_results
            )
            return result

        name_filter = normalize_glob(query.glob or "")
        files_scanned = 0
        stop = False
        for dirpath, dirnames, filenames in os.walk(base):
            # Prune noise dirs in place so os.walk never descends into them.
            dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
            for fname in sorted(filenames):
                if name_filter and not fnmatch.fnmatch(fname, name_filter):
                    continue

                files_scanned += 1
                if files_scanned > _MAX_FILES_SCANNED:
                    result.truncated = True
                    stop = True
                    break

                if self._grep_one_file(
                    Path(dirpath) / fname,
                    regex,
                    result,
                    files_only=query.files_only,
                    max_results=max_results,
                ):
                    stop = True
                    break
            if stop:
                break

        return result

    def _grep_one_file(
        self,
        abs_path: Path,
        regex: re.Pattern[str],
        result: GrepResult,
        *,
        files_only: bool,
        max_results: int,
    ) -> bool:
        """Scan one file's lines into ``result``; return True if a result cap hit.

        Shared by the single-file fast path and the directory walk so both render
        identical ``rel:line: text`` hits, per-file counts, and truncation flags.
        """
        text = read_text_file(abs_path)
        if text is None:  # binary / too large / unreadable — skip
            return False

        rel = _posix(os.path.relpath(abs_path, self._root))
        file_count = 0
        stop = False
        for lineno, line in enumerate(text.splitlines(), start=1):
            if not regex.search(line):
                continue
            file_count += 1
            result.total_matches += 1
            if not files_only:
                result.hits.append(GrepHit(rel, lineno, _trim(line)))
                if len(result.hits) >= max_results:
                    result.truncated = True
                    stop = True
                    break

        if file_count:
            result.file_counts.append((rel, file_count))
            if files_only and len(result.file_counts) >= max_results:
                result.truncated = True
                stop = True
        return stop

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
        self._dirty = True
        return await self._sandbox.execute(replace(req, cwd=str(self._root.resolve())))
