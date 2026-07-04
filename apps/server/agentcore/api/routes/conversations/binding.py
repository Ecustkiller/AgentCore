"""Local-mode binding (双模式工作区 §七: 模式跟着文件在哪自动走)."""

from fastapi import APIRouter, Depends

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
)
from agentcore.api.schemas import BindLocalWorkspaceRequest, WorkspaceBindingResponse
from agentcore.conversation.scratch import resolve_conversation_local_binding
from agentcore.core.errors import NotFoundError
from agentcore.db.models import Conversation
from agentcore.db.repositories import ConversationRepository

from ._helpers import _get_owned_conversation

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _binding_response(conv: Conversation) -> WorkspaceBindingResponse:
    """Render a conversation's scratch workspace mode (§七) as the API response."""
    binding = resolve_conversation_local_binding(
        local_root_id=conv.local_root_id,
        local_subpath=conv.local_subpath,
        label="workspace",
    )
    if binding is None:
        return WorkspaceBindingResponse(mode="cloud", scope="conversation", root_id=None)
    return WorkspaceBindingResponse(mode="local", scope="conversation", root_id=binding.root_id)


@router.get("/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse)
async def get_workspace_binding(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Report a conversation's resolved scratch workspace mode (local vs cloud)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    return _binding_response(conv)


@router.put("/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse)
async def bind_workspace(
    conversation_id: str,
    body: BindLocalWorkspaceRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Bind the conversation's scratch workspace to a desktop FS root (switch to local).

    Idempotent — re-binding overwrites the stored root id on the conversation row.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    await conv_repo.set_local_binding(conversation_id, root_id=body.root_id, subpath=None)
    conv = await conv_repo.get_by_id(conversation_id, user_id=user.user_id)
    if not conv:
        raise NotFoundError("对话不存在")
    return _binding_response(conv)


@router.delete("/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse)
async def unbind_workspace(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Unbind the conversation's scratch workspace (fall back to cloud)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    await conv_repo.set_local_binding(conversation_id, root_id=None, subpath=None)
    conv = await conv_repo.get_by_id(conversation_id, user_id=user.user_id)
    if not conv:
        raise NotFoundError("对话不存在")
    return _binding_response(conv)
