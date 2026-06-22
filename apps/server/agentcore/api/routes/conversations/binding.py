"""Local-mode binding (双模式工作区 §七: 模式跟着文件在哪自动走)."""

from fastapi import APIRouter, Depends

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_folder_repo,
)
from agentcore.api.schemas import BindLocalWorkspaceRequest, WorkspaceBindingResponse
from agentcore.conversation.service import promote_conversation_folder
from agentcore.core.errors import NotFoundError
from agentcore.db.models import Conversation
from agentcore.db.repositories import ConversationRepository, FolderRepository
from agentcore.workspace.locate import default_workspace_name, resolve_local_binding

from ._helpers import _get_owned_conversation

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _binding_response(conv: Conversation, folder: object | None) -> WorkspaceBindingResponse:
    """Render a conversation's resolved workspace mode (§七) as the API response.

    文件夹即工作区: a binding lives on the folder (shared by its siblings), so a filed
    conversation reports ``scope="folder"`` — unbinding affects every chat in it. A
    裸聊 has no folder/workspace, so it is always cloud and reports
    ``scope="conversation"`` (only itself).
    """
    scope = "folder" if conv.folder_id else "conversation"
    binding = resolve_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=getattr(folder, "local_root_id", None),
    )
    if binding is None:
        return WorkspaceBindingResponse(mode="cloud", scope=scope, root_id=None)
    return WorkspaceBindingResponse(mode="local", scope=scope, root_id=binding.root_id)


@router.get("/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse)
async def get_workspace_binding(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Report a conversation's resolved workspace mode (local vs cloud).

    Backs the desktop's mode badge: cloud by default, local once its governing
    scope (folder when filed, else the conversation) is bound to a desktop root.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    folder = (
        await folder_repo.get_by_id(conv.folder_id, user_id=user.user_id)
        if conv.folder_id
        else None
    )
    return _binding_response(conv, folder)


@router.put("/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse)
async def bind_workspace(
    conversation_id: str,
    body: BindLocalWorkspaceRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Bind the conversation's workspace to a desktop FS root (switch to local).

    文件夹即工作区: a binding lives on the folder (= 工作区), shared by its siblings.
    A 裸聊 has no folder yet, so "打开本地文件夹" lazily mints one (named after the
    chat) and files the conversation into it before binding — the explicit-promote
    counterpart to writing a file (§懒建). Idempotent — re-binding overwrites the
    stored root id.

    The 裸聊 mint goes through the shared ``promote_conversation_folder`` so it's
    serialized + idempotent with the other promotion paths (工作区对称化 D1a §并发提升):
    if a panel write or the turn's first write already minted this chat's folder, bind
    reuses it (applying the requested root) instead of minting a second one.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if not conv.folder_id:
        folder, reused = await promote_conversation_folder(
            conv_repo=conv_repo,
            folder_repo=folder_repo,
            user_id=user.user_id,
            conversation_id=conversation_id,
            mint=lambda: folder_repo.create(
                user_id=user.user_id,
                name=default_workspace_name(conv.title),
                local_root_id=body.root_id,
            ),
        )
        if reused and folder.local_root_id != body.root_id:
            # Lost the mint race to a concurrent first write — apply the requested
            # binding to the folder it minted so "打开本地文件夹" still takes effect.
            await folder_repo.set_local_root_id(folder.id, body.root_id, user_id=user.user_id)
        return WorkspaceBindingResponse(mode="local", scope="folder", root_id=body.root_id)
    folder = await folder_repo.set_local_root_id(conv.folder_id, body.root_id, user_id=user.user_id)
    if not folder:
        raise NotFoundError("文件夹不存在")
    return WorkspaceBindingResponse(mode="local", scope="folder", root_id=body.root_id)


@router.delete("/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse)
async def unbind_workspace(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Unbind the conversation's workspace (fall back to cloud).

    Clears the binding on the folder (= 工作区), returning every conversation in it
    to cloud — which the ``folder`` scope in the response signals. A 裸聊 has no
    workspace to unbind, so it is already cloud (a no-op).
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if not conv.folder_id:
        return WorkspaceBindingResponse(mode="cloud", scope="conversation", root_id=None)
    folder = await folder_repo.set_local_root_id(conv.folder_id, None, user_id=user.user_id)
    if not folder:
        raise NotFoundError("文件夹不存在")
    return WorkspaceBindingResponse(mode="cloud", scope="folder", root_id=None)
