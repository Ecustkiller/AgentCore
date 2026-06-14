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
import tempfile
from dataclasses import replace
from pathlib import Path

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
    """``WorkspaceBackend`` backed by a server-side directory + sandbox."""

    location = "server"

    def __init__(
        self,
        root: Path,
        sandbox: SandboxProvider,
        *,
        root_label: str = "workspace",
    ) -> None:
        self._root = root
        self._sandbox = sandbox
        self.root_label = root_label
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
        if not base.is_dir():
            raise NotADirectory(query.directory)

        flags = re.IGNORECASE if query.case_insensitive else 0
        regex = re.compile(query.pattern, flags)
        name_filter = normalize_glob(query.glob or "")
        max_results = max(1, min(query.max_results, _MAX_RESULTS_CAP))

        result = GrepResult()
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

                text = read_text_file(Path(dirpath) / fname)
                if text is None:
                    continue

                rel = _posix(os.path.relpath(Path(dirpath) / fname, self._root))
                file_count = 0
                for lineno, line in enumerate(text.splitlines(), start=1):
                    if not regex.search(line):
                        continue
                    file_count += 1
                    result.total_matches += 1
                    if not query.files_only:
                        result.hits.append(GrepHit(rel, lineno, _trim(line)))
                        if len(result.hits) >= max_results:
                            result.truncated = True
                            stop = True
                            break

                if file_count:
                    result.file_counts.append((rel, file_count))
                    if query.files_only and len(result.file_counts) >= max_results:
                        result.truncated = True
                        stop = True
                if stop:
                    break
            if stop:
                break

        return result

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
