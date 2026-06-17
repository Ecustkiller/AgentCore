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
from dataclasses import dataclass

from agentcore.runtime.events import EventSink
from agentcore.tools.sandbox.protocol import ExecutionRequest, ExecutionResult
from agentcore.workspace.locate import (
    LocalBinding,
    build_local_workspace,
    build_server_workspace,
)
from agentcore.workspace.protocol import (
    DirEntry,
    GrepQuery,
    GrepResult,
    PathNotFound,
    ReplaceOutcome,
    WorkspaceBackend,
)


@dataclass(frozen=True)
class PromotionResult:
    """The outcome of promoting a 裸聊 into a real folder on its first file write.

    ``folder_id`` is the minted folder (so the rest of the turn + the end-of-run
    snapshot target it). ``local_binding`` is set when the chat was promoted into a
    **local** workspace (工作区对称化 D1a): a desktop sub-directory under a shared
    container root, so the inner backend must be a ``LocalWorkspace`` reached over
    the turn's channel rather than a server-hosted ``ServerWorkspace``. ``None``
    keeps the cloud path (the original behavior).
    """

    folder_id: str
    local_binding: LocalBinding | None = None


# Promotes the conversation and returns where it landed (folder + cloud/local).
PromoteFn = Callable[[], Awaitable[PromotionResult]]


class DeferredWorkspace:
    """A folderless conversation's workspace: empty until the first file is created.

    Satisfies ``WorkspaceBackend`` (location/root_label/dirty + the op surface) so it
    drops into the pipeline like any other backend. ``promote`` is invoked at most
    once, on the first creating op.
    """

    def __init__(
        self,
        *,
        user_id: str,
        promote: PromoteFn,
        sink: EventSink | None = None,
        conversation_id: str = "",
        root_label: str = "workspace",
    ) -> None:
        self._user_id = user_id
        self._promote = promote
        # Needed only to build a LocalWorkspace inner on a *local* promotion (工作区
        # 对称化 D1a): the channel rides this turn's ``sink``. Unused for cloud.
        self._sink = sink
        self._conversation_id = conversation_id
        self._root_label = root_label
        self._inner: WorkspaceBackend | None = None
        self._folder_id: str | None = None

    @property
    def location(self) -> str:
        """The materialized backend's location, defaulting to cloud pre-promotion.

        Dynamic (not a fixed attribute) because a 裸聊 may be promoted into either a
        cloud (``ServerWorkspace``) or a local (``LocalWorkspace``) folder (工作区
        对称化 D1a). The end-of-turn snapshot guard keys on this, so a locally-
        promoted chat must report ``"local"`` — otherwise the turn would try to
        snapshot an empty server-side directory whose files actually live on the
        user's machine.
        """
        return self._inner.location if self._inner is not None else "server"

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

    async def _materialize(self) -> WorkspaceBackend:
        """Promote on first use, then return the real backend (idempotent).

        The promotion decides cloud vs local: a ``local_binding`` builds a
        ``LocalWorkspace`` over this turn's channel (files land on the user's
        machine under the container root's subpath, 工作区对称化 D1a); otherwise a
        server-hosted ``ServerWorkspace`` (the original cloud path).
        """
        if self._inner is None:
            result = await self._promote()
            self._folder_id = result.folder_id
            if result.local_binding is not None:
                if self._sink is None:
                    raise RuntimeError(
                        "local promotion requires the turn's sink for its channel"
                    )
                self._inner = build_local_workspace(
                    binding=result.local_binding,
                    sink=self._sink,
                    conversation_id=self._conversation_id,
                )
            else:
                self._inner = build_server_workspace(
                    user_id=self._user_id,
                    folder_id=result.folder_id,
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

    async def index_files(
        self, cap: int | None = None, *, order: str = "path"
    ) -> tuple[list[str], bool]:
        if self._inner is None:
            return ([], False)
        return await self._inner.index_files(cap, order=order)
