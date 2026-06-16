"""DeferredWorkspace — a 裸聊 (folderless conversation) has no workspace until it
first produces files (文件夹即工作区 §懒建 / 决策 B).

The new mental model is **文件夹 = 工作区**: a conversation only owns files through
its folder. A brand-new chat has no folder, so it has no workspace — keeping casual
"just ask a question" chats zero-cost (no empty dir, no sidebar project). The moment
the team (or an upload) actually *creates* a file, we lazily promote the chat into a
real folder workspace and forward every op there.

This backend wraps that laziness behind the ``WorkspaceBackend`` seam so the engine
and tools stay oblivious:

- **Creating ops** (``write`` / ``write_bytes`` / ``mkdir`` / ``execute``) trigger
  ``promote`` once — it mints the folder, files the conversation into it, and returns
  the ``folder_id`` — then build the real ``ServerWorkspace`` and forward.
- **Existing-target ops** (``read`` / ``read_bytes`` / ``replace`` / ``delete`` /
  ``move``) never promote: on an empty workspace they would only fail, so they raise
  ``PathNotFound`` until something has been created.
- **Listing ops** (``list`` / ``grep`` / ``index_files``) report an empty workspace
  until promotion.

After promotion, ``folder_id`` exposes the new folder so the turn's end-of-run
snapshot backs up the right directory (决策⑥).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from agentcore.tools.sandbox.protocol import ExecutionRequest, ExecutionResult
from agentcore.workspace.locate import build_server_workspace
from agentcore.workspace.protocol import (
    DirEntry,
    GrepQuery,
    GrepResult,
    PathNotFound,
    ReplaceOutcome,
)
from agentcore.workspace.server import ServerWorkspace

# Returns the id of the folder the conversation was promoted into.
PromoteFn = Callable[[], Awaitable[str]]


class DeferredWorkspace:
    """A folderless conversation's workspace: empty until the first file is created.

    Satisfies ``WorkspaceBackend`` (location/root_label/dirty + the op surface) so it
    drops into the pipeline like any other backend. ``promote`` is invoked at most
    once, on the first creating op.
    """

    location = "server"

    def __init__(
        self,
        *,
        user_id: str,
        promote: PromoteFn,
        root_label: str = "workspace",
    ) -> None:
        self._user_id = user_id
        self._promote = promote
        self._root_label = root_label
        self._inner: ServerWorkspace | None = None
        self._folder_id: str | None = None

    @property
    def root_label(self) -> str:
        return self._inner.root_label if self._inner is not None else self._root_label

    @property
    def dirty(self) -> bool:
        return self._inner.dirty if self._inner is not None else False

    @property
    def folder_id(self) -> str | None:
        """The folder this chat was promoted into, or ``None`` if never written.

        Read after the turn so the snapshot targets the materialized folder rather
        than the (non-existent) 裸聊 path.
        """
        return self._folder_id

    async def _materialize(self) -> ServerWorkspace:
        """Promote on first use, then return the real backend (idempotent)."""
        if self._inner is None:
            self._folder_id = await self._promote()
            self._inner = build_server_workspace(
                user_id=self._user_id,
                folder_id=self._folder_id,
                conversation_id="",
            )
        return self._inner

    # --- creating ops: promote, then forward ------------------------------------
    async def write(self, path: str, content: str) -> int:
        return await (await self._materialize()).write(path, content)

    async def write_bytes(self, path: str, data: bytes) -> int:
        return await (await self._materialize()).write_bytes(path, data)

    async def mkdir(self, path: str) -> None:
        await (await self._materialize()).mkdir(path)

    async def execute(self, req: ExecutionRequest) -> ExecutionResult:
        return await (await self._materialize()).execute(req)

    # --- existing-target ops: nothing exists until promotion --------------------
    async def read(self, path: str) -> str:
        if self._inner is None:
            raise PathNotFound(path)
        return await self._inner.read(path)

    async def read_bytes(self, path: str) -> bytes:
        if self._inner is None:
            raise PathNotFound(path)
        return await self._inner.read_bytes(path)

    async def replace(
        self, path: str, old: str, new: str, *, all_: bool
    ) -> ReplaceOutcome:
        if self._inner is None:
            raise PathNotFound(path)
        return await self._inner.replace(path, old, new, all_=all_)

    async def delete(self, path: str) -> None:
        if self._inner is None:
            raise PathNotFound(path)
        await self._inner.delete(path)

    async def move(self, src: str, dst: str) -> None:
        if self._inner is None:
            raise PathNotFound(src)
        await self._inner.move(src, dst)

    # --- listing ops: empty until promotion -------------------------------------
    async def list(self, directory: str, pattern: str) -> list[DirEntry]:
        if self._inner is None:
            return []
        return await self._inner.list(directory, pattern)

    async def grep(self, query: GrepQuery) -> GrepResult:
        if self._inner is None:
            return GrepResult()
        return await self._inner.grep(query)

    async def index_files(self, cap: int | None = None) -> tuple[list[str], bool]:
        if self._inner is None:
            return ([], False)
        if cap is None:
            return await self._inner.index_files()
        return await self._inner.index_files(cap)
