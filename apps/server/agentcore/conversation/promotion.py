"""裸聊懒升级 / folder promotion (工作区对称化 D1a)."""

from collections.abc import Awaitable, Callable

from agentcore.core.errors import NotFoundError
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.models import Folder
from agentcore.db.repositories import ConversationRepository, FolderRepository
from agentcore.messaging.hub import default_chat_hub
from agentcore.runtime.events import EventSink, workspace_promoted
from agentcore.workspace.deferred import PromotionResult
from agentcore.workspace.locate import LocalBinding, default_workspace_name, workspace_storage_key
from agentcore.workspace.locks import workspace_lock

logger = get_logger(__name__)

_SUBPATH_FORBIDDEN = set('<>:"/\\|?*') | {chr(c) for c in range(32)}
_SUBPATH_MAX = 80


def _sanitize_subpath_segment(name: str) -> str:
    """Turn a workspace name into one FS-safe directory segment (工作区对称化 D1a)."""
    cleaned = "".join(c for c in name if c not in _SUBPATH_FORBIDDEN)
    cleaned = " ".join(cleaned.split()).rstrip(". ")
    return cleaned[:_SUBPATH_MAX].rstrip(". ") or "workspace"


async def _unique_local_subpath(
    repo: FolderRepository, *, user_id: str, container_root_id: str, name: str
) -> str:
    """A subpath segment for ``name`` not already used by a folder in the container."""
    base = _sanitize_subpath_segment(name)
    folders = await repo.list_by_user(user_id)
    taken = {
        f.local_subpath for f in folders if f.local_root_id == container_root_id and f.local_subpath
    }
    if base not in taken:
        return base
    i = 2
    while f"{base}-{i}" in taken:
        i += 1
    return f"{base}-{i}"


def _promotion_lock_key(*, user_id: str, conversation_id: str) -> str:
    base = workspace_storage_key(user_id=user_id, folder_id=None, conversation_id=conversation_id)
    return f"{base}#promote"


def _container_root_lock_key(*, user_id: str, container_root_id: str) -> str:
    return f"promote-root/{user_id}/{container_root_id}"


async def _broadcast_promotion(*, user_id: str, conversation_id: str, folder: Folder) -> None:
    await default_chat_hub().publish(
        [user_id],
        {
            "type": "workspace_promoted",
            "conversation_id": conversation_id,
            "folder_id": folder.id,
            "name": folder.name,
            "local_root_id": folder.local_root_id,
            "local_subpath": folder.local_subpath or "",
        },
    )


async def promote_conversation_folder(
    *,
    conv_repo: ConversationRepository,
    folder_repo: FolderRepository,
    user_id: str,
    conversation_id: str,
    mint: Callable[[], Awaitable[Folder]],
) -> tuple[Folder, bool]:
    """Serialize + idempotently get-or-mint the folder a 裸聊 is promoted into."""
    async with workspace_lock(
        _promotion_lock_key(user_id=user_id, conversation_id=conversation_id)
    ):
        existing_folder_id = await conv_repo.get_folder_id(conversation_id)
        if existing_folder_id is not None:
            folder = await folder_repo.get_by_id(existing_folder_id, user_id=user_id)
            if folder is None:
                raise NotFoundError("工作区不存在")
            return folder, True
        folder = await mint()
        await conv_repo.set_folder(conversation_id, folder.id, user_id=user_id)
        await _broadcast_promotion(user_id=user_id, conversation_id=conversation_id, folder=folder)
        return folder, False


def _finish_promotion(
    *,
    sink: EventSink | None,
    conversation_id: str,
    folder_id: str,
    name: str,
    local_root_id: str | None,
    local_subpath: str | None,
) -> PromotionResult:
    binding = (
        LocalBinding(root_id=local_root_id, root_label=name, subpath=local_subpath or "")
        if local_root_id
        else None
    )
    if sink is not None:
        sink.emit(
            workspace_promoted(
                conversation_id=conversation_id,
                folder_id=folder_id,
                name=name,
                local_root_id=local_root_id,
                local_subpath=local_subpath or "",
            )
        )
    return PromotionResult(folder_id=folder_id, local_binding=binding)


async def promote_bare_chat_to_folder(
    *,
    conv_repo: ConversationRepository,
    folder_repo: FolderRepository,
    user_id: str,
    conversation_id: str,
    title: str | None,
    user_message: str = "",
    local_container_root_id: str | None,
    sink: EventSink | None = None,
) -> PromotionResult:
    """Mint a folder for a 裸聊 and file the conversation into it (文件夹即工作区 §懒建)."""

    async def _mint() -> Folder:
        name = default_workspace_name(title, fallback_text=user_message)
        if not local_container_root_id:
            return await folder_repo.create(
                user_id=user_id, name=name, local_root_id=None, local_subpath=None
            )
        async with workspace_lock(
            _container_root_lock_key(user_id=user_id, container_root_id=local_container_root_id)
        ):
            local_subpath = await _unique_local_subpath(
                folder_repo,
                user_id=user_id,
                container_root_id=local_container_root_id,
                name=name,
            )
            return await folder_repo.create(
                user_id=user_id,
                name=name,
                local_root_id=local_container_root_id,
                local_subpath=local_subpath,
            )

    folder, reused = await promote_conversation_folder(
        conv_repo=conv_repo,
        folder_repo=folder_repo,
        user_id=user_id,
        conversation_id=conversation_id,
        mint=_mint,
    )
    logger.info(
        "workspace.bare_chat_promote_reused" if reused else "workspace.bare_chat_promoted",
        conversation_id=conversation_id,
        folder_id=folder.id,
        location="local" if folder.local_root_id else "server",
    )
    return _finish_promotion(
        sink=sink,
        conversation_id=conversation_id,
        folder_id=folder.id,
        name=folder.name,
        local_root_id=folder.local_root_id,
        local_subpath=folder.local_subpath,
    )


def bare_chat_promote(
    *,
    user_id: str,
    conversation_id: str,
    title: str | None,
    user_message: str,
    local_container_root_id: str | None,
    sink: EventSink,
):
    """Build the lazy-promotion callback for a 裸聊 turn (文件夹即工作区 §懒建)."""

    async def _promote() -> PromotionResult:
        async with async_session_factory() as session:
            return await promote_bare_chat_to_folder(
                conv_repo=ConversationRepository(session),
                folder_repo=FolderRepository(session),
                user_id=user_id,
                conversation_id=conversation_id,
                title=title,
                user_message=user_message,
                local_container_root_id=local_container_root_id,
                sink=sink,
            )

    return _promote


# Re-exported for tests that import private helpers from service.
sanitize_subpath_segment = _sanitize_subpath_segment
unique_local_subpath = _unique_local_subpath
