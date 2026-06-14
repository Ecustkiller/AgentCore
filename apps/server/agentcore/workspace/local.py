"""LocalWorkspace — files and code execution on the user's machine (local mode).

The second ``WorkspaceBackend`` implementation. It owns no disk of its own: every
op is serialized and routed over a ``WorkspaceChannel`` to the bound desktop
client, which runs it against the real local directory (reusing the desktop's
authorized FS roots + traversal guard) and posts back a structured result. The
backend then returns the same typed values / raises the same ``WorkspaceError``
subclasses as ``ServerWorkspace`` — so the file tools and the engine run against
it **unchanged** (the whole point of the P0 seam).

P2a scope: ``read`` / ``list`` / ``grep`` are wired end-to-end through the channel
(read-only, low-risk). The mutating ops and ``execute`` already route through the
same channel here (the server side is complete and symmetric); their desktop
handlers + the local-execution approval posture land in P2b / P2c. Until then a
desktop that does not yet implement an op answers with an ``unsupported`` error,
which surfaces as a normal ``WorkspaceIOError`` rather than a hang.
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


class LocalWorkspace:
    """``WorkspaceBackend`` backed by the desktop, reached over a channel."""

    location = "local"

    def __init__(
        self,
        channel: WorkspaceChannel,
        *,
        root_label: str = "workspace",
    ) -> None:
        self._channel = channel
        self.root_label = root_label
        # Flips True on the first mutating op so the service snapshots only
        # workspaces a turn actually changed (see WorkspaceBackend.dirty). For
        # local mode the snapshot is the 本地→云 handoff bridge (§四 / P2e).
        self._dirty = False

    @property
    def dirty(self) -> bool:
        return self._dirty

    async def read(self, path: str) -> str:
        value = await self._channel.request(WorkspaceOp.READ, {"path": path})
        return str(value)

    async def write(self, path: str, content: str) -> int:
        value = await self._channel.request(
            WorkspaceOp.WRITE, {"path": path, "content": content}
        )
        self._dirty = True
        return int(value)

    async def read_bytes(self, path: str) -> bytes:
        # The desktop returns base64 (JSON has no byte type); decode back to raw.
        value = await self._channel.request(WorkspaceOp.READ_BYTES, {"path": path})
        return base64.b64decode(str(value))

    async def write_bytes(self, path: str, data: bytes) -> int:
        value = await self._channel.request(
            WorkspaceOp.WRITE_BYTES,
            {"path": path, "data": base64.b64encode(data).decode("ascii")},
        )
        self._dirty = True
        return int(value)

    async def list(self, directory: str, pattern: str) -> list[DirEntry]:
        value = await self._channel.request(
            WorkspaceOp.LIST, {"directory": directory, "pattern": pattern}
        )
        return [
            DirEntry(path=str(e["path"]), is_dir=bool(e["is_dir"]))
            for e in (value or [])
        ]

    async def mkdir(self, path: str) -> None:
        await self._channel.request(WorkspaceOp.MKDIR, {"path": path})
        self._dirty = True

    async def delete(self, path: str) -> None:
        await self._channel.request(WorkspaceOp.DELETE, {"path": path})
        self._dirty = True

    async def move(self, src: str, dst: str) -> None:
        await self._channel.request(WorkspaceOp.MOVE, {"src": src, "dst": dst})
        self._dirty = True

    async def replace(
        self, path: str, old: str, new: str, *, all_: bool
    ) -> ReplaceOutcome:
        value = await self._channel.request(
            WorkspaceOp.REPLACE,
            {"path": path, "old": old, "new": new, "all": all_},
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
                "directory": query.directory,
                "glob": query.glob,
                "case_insensitive": query.case_insensitive,
                "files_only": query.files_only,
                "max_results": query.max_results,
            },
        )
        return GrepResult(
            hits=[
                GrepHit(path=str(h["path"]), line_no=int(h["line_no"]), text=str(h["text"]))
                for h in value.get("hits", [])
            ],
            file_counts=[
                (str(fc[0]), int(fc[1])) for fc in value.get("file_counts", [])
            ],
            total_matches=int(value.get("total_matches", 0)),
            truncated=bool(value.get("truncated", False)),
        )

    async def execute(self, req: ExecutionRequest) -> ExecutionResult:
        # cwd is the desktop's job (it runs code in the bound local directory), so
        # it is not sent; the rest of the request is serialized verbatim. Marked
        # dirty conservatively — executed code commonly writes artifacts and the
        # backend cannot introspect what ran (mirrors ServerWorkspace.execute).
        self._dirty = True
        value: dict[str, Any] = await self._channel.request(
            WorkspaceOp.EXECUTE,
            {
                "code": req.code,
                "language": req.language,
                "timeout_seconds": req.timeout_seconds,
                "memory_limit_mb": req.memory_limit_mb,
                "stdin": req.stdin,
            },
        )
        return ExecutionResult(
            success=bool(value["success"]),
            stdout=str(value.get("stdout", "")),
            stderr=str(value.get("stderr", "")),
            exit_code=int(value.get("exit_code", 0)),
            duration_ms=int(value.get("duration_ms", 0)),
        )
