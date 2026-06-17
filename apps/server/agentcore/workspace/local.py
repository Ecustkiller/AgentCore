"""LocalWorkspace — files and code execution on the user's machine (local mode).

The second ``WorkspaceBackend`` implementation. It owns no disk of its own: every
op is serialized and routed over a ``WorkspaceChannel`` to the bound desktop
client, which runs it against the real local directory (reusing the desktop's
authorized FS roots + traversal guard) and posts back a structured result. The
backend then returns the same typed values / raises the same ``WorkspaceError``
subclasses as ``ServerWorkspace`` — so the file tools and the engine run against
it **unchanged** (the whole point of the P0 seam).

All ops (read / list / grep / the mutating ops / ``execute``) are wired end-to-end
through the channel and handled by the desktop. Two policies make ``execute`` safe
on the user's real machine (双模式工作区 P2d 执行门):

* **Approval** is enforced *upstream* at the engine's ``ApprovalGate`` (before the
  op is ever issued), for the CEO and — in local mode — for delegated workers too,
  so no code runs on the user's machine without consent. The channel itself adds
  no gate (that would double-prompt the CEO).
* **Timeout**: ``execute`` extends the channel's transport deadline to the code's
  own ``timeout_seconds`` plus a slack, so the desktop's execution limit stays
  authoritative and a long but legal run is not cut off by the flat file-op
  deadline. A dropped desktop still fails as a ``WorkspaceIOError`` (never hangs).
"""

from __future__ import annotations

import base64
from typing import Any

from agentcore.tools.sandbox.protocol import ExecutionRequest, ExecutionResult
from agentcore.workspace.channel import WorkspaceChannel, WorkspaceOp
from agentcore.workspace.protocol import (
    DirEntry,
    GrepHit,
    GrepQuery,
    GrepResult,
    ReplaceOutcome,
)

# Default extra transport budget (seconds) over a code execution's own timeout
# (see Settings.workspace_execute_timeout_slack_seconds). Used when a LocalWorkspace
# is built without an explicit slack (e.g. tests); locate.py injects the configured
# value for real turns.
_DEFAULT_EXECUTE_TIMEOUT_SLACK = 30.0


class LocalWorkspace:
    """``WorkspaceBackend`` backed by the desktop, reached over a channel."""

    location = "local"

    def __init__(
        self,
        channel: WorkspaceChannel,
        *,
        root_label: str = "workspace",
        execute_timeout_slack: float = _DEFAULT_EXECUTE_TIMEOUT_SLACK,
        base_subpath: str = "",
    ) -> None:
        self._channel = channel
        self.root_label = root_label
        # Added to an execute's own timeout to form its transport deadline, so the
        # desktop's execution limit (not the channel) decides when code is killed.
        self._execute_timeout_slack = execute_timeout_slack
        # Sub-directory within the bound root this workspace is scoped to (工作区
        # 对称化 D1a). Empty = the root itself (current behavior, every op below is a
        # no-op pass-through). Non-empty = every op path is prefixed with it on the
        # way to the desktop and stripped on the way back, so the engine, tools, and
        # the user only ever see workspace-relative paths — the container root the
        # channel is bound to never leaks. POSIX, no trailing slash.
        self._base = base_subpath.strip("/")
        # Flips True on the first mutating op so the service snapshots only
        # workspaces a turn actually changed (see WorkspaceBackend.dirty). For
        # local mode the snapshot is the 本地→云 handoff bridge (§四 / P2e).
        self._dirty = False

    @property
    def dirty(self) -> bool:
        return self._dirty

    def _in(self, path: str) -> str:
        """Workspace-relative path → container-relative (prefix the subpath base).

        No-op when unscoped. ``""``/``"."`` (the workspace root) map to the base
        itself so ``list``/``index`` target the right subtree.
        """
        if not self._base:
            return path
        rel = path.strip("/")
        if not rel or rel == ".":
            return self._base
        return f"{self._base}/{rel}"

    def _out(self, path: str) -> str:
        """Container-relative path → workspace-relative (strip the subpath base).

        The inverse of :meth:`_in` for results that carry paths (list / grep /
        index). No-op when unscoped; a path already outside the base is returned
        unchanged (defensive — the desktop should only ever return in-subtree paths
        once it scopes by base).
        """
        if not self._base:
            return path
        if path == self._base:
            return ""
        prefix = f"{self._base}/"
        return path[len(prefix):] if path.startswith(prefix) else path

    async def read(self, path: str) -> str:
        value = await self._channel.request(WorkspaceOp.READ, {"path": self._in(path)})
        return str(value)

    async def write(self, path: str, content: str) -> int:
        value = await self._channel.request(
            WorkspaceOp.WRITE, {"path": self._in(path), "content": content}
        )
        self._dirty = True
        return int(value)

    async def read_bytes(self, path: str) -> bytes:
        # The desktop returns base64 (JSON has no byte type); decode back to raw.
        value = await self._channel.request(
            WorkspaceOp.READ_BYTES, {"path": self._in(path)}
        )
        return base64.b64decode(str(value))

    async def write_bytes(self, path: str, data: bytes) -> int:
        value = await self._channel.request(
            WorkspaceOp.WRITE_BYTES,
            {"path": self._in(path), "data": base64.b64encode(data).decode("ascii")},
        )
        self._dirty = True
        return int(value)

    async def list(self, directory: str, pattern: str) -> list[DirEntry]:
        value = await self._channel.request(
            WorkspaceOp.LIST, {"directory": self._in(directory), "pattern": pattern}
        )
        return [
            DirEntry(path=self._out(str(e["path"])), is_dir=bool(e["is_dir"]))
            for e in (value or [])
        ]

    async def index_files(
        self, cap: int | None = None, *, order: str = "path"
    ) -> tuple[list[str], bool]:
        # The desktop indexes the bound local root (its fsApi.listFiles walk: ignore
        # dirs pruned, capped) and returns {paths, truncated}, so @ mentions + the
        # worker manifest see the same flat view as cloud. ``order`` selects the sort
        # ("path" alphabetical for @, "recent" newest-first for the manifest budget).
        # ``base`` scopes the walk to this workspace's subtree (工作区对称化 D1a) so a
        # shared container root indexes only this workspace; returned paths are
        # stripped back to workspace-relative. Read-only → not dirty.
        value = await self._channel.request(
            WorkspaceOp.INDEX_FILES, {"cap": cap, "order": order, "base": self._in(".")}
        )
        value = value or {}
        paths = [self._out(str(p)) for p in value.get("paths", [])]
        return paths, bool(value.get("truncated", False))

    async def mkdir(self, path: str) -> None:
        await self._channel.request(WorkspaceOp.MKDIR, {"path": self._in(path)})
        self._dirty = True

    async def delete(self, path: str) -> None:
        await self._channel.request(WorkspaceOp.DELETE, {"path": self._in(path)})
        self._dirty = True

    async def move(self, src: str, dst: str) -> None:
        await self._channel.request(
            WorkspaceOp.MOVE, {"src": self._in(src), "dst": self._in(dst)}
        )
        self._dirty = True

    async def replace(
        self, path: str, old: str, new: str, *, all_: bool
    ) -> ReplaceOutcome:
        value = await self._channel.request(
            WorkspaceOp.REPLACE,
            {"path": self._in(path), "old": old, "new": new, "all": all_},
        )
        self._dirty = True
        first_line = value.get("first_line")
        return ReplaceOutcome(
            count=int(value["count"]),
            first_line=None if first_line is None else int(first_line),
        )

    async def grep(self, query: GrepQuery) -> GrepResult:
        value = await self._channel.request(
            WorkspaceOp.GREP,
            {
                "pattern": query.pattern,
                "directory": self._in(query.directory),
                "glob": query.glob,
                "case_insensitive": query.case_insensitive,
                "files_only": query.files_only,
                "max_results": query.max_results,
            },
        )
        return GrepResult(
            hits=[
                GrepHit(
                    path=self._out(str(h["path"])),
                    line_no=int(h["line_no"]),
                    text=str(h["text"]),
                )
                for h in value.get("hits", [])
            ],
            file_counts=[
                (self._out(str(fc[0])), int(fc[1])) for fc in value.get("file_counts", [])
            ],
            total_matches=int(value.get("total_matches", 0)),
            truncated=bool(value.get("truncated", False)),
        )

    async def execute(self, req: ExecutionRequest) -> ExecutionResult:
        # cwd is the desktop's job (it runs code in the bound local directory). It is
        # sent only as a workspace subtree hint (``cwd`` = the subpath base, 工作区
        # 对称化 D1a) so a scoped workspace runs code in its own dir rather than the
        # shared container root; empty = the root (current behavior). Marked dirty
        # conservatively — executed code commonly writes artifacts and the backend
        # cannot introspect what ran (mirrors ServerWorkspace.execute).
        self._dirty = True
        value: dict[str, Any] = await self._channel.request(
            WorkspaceOp.EXECUTE,
            {
                "code": req.code,
                "language": req.language,
                "timeout_seconds": req.timeout_seconds,
                "memory_limit_mb": req.memory_limit_mb,
                "stdin": req.stdin,
                "cwd": self._base,
            },
            # Outlive the desktop's own execution timeout (the authoritative kill)
            # by the slack, so a long but legal run is not cut off by the flat
            # file-op deadline — only a truly gone desktop trips the transport.
            timeout=float(req.timeout_seconds) + self._execute_timeout_slack,
        )
        return ExecutionResult(
            success=bool(value["success"]),
            stdout=str(value.get("stdout", "")),
            stderr=str(value.get("stderr", "")),
            exit_code=int(value.get("exit_code", 0)),
            duration_ms=int(value.get("duration_ms", 0)),
        )
