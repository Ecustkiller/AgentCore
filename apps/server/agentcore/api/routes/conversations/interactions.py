"""Interaction resolution: settle a paused approval / ask_user / client_tool (§18.2)."""

from fastapi import APIRouter, Body, Depends

from agentcore.api.dependencies import AuthUser, get_conversation_repo
from agentcore.api.schemas import (
    ResolveInteractionRequest,
    StatusResponse,
    interaction_result_from_body,
)
from agentcore.core.errors import NotFoundError
from agentcore.db.repositories import ConversationRepository
from agentcore.runtime.interaction import default_interaction_registry

from ._helpers import _require_owned_conversation

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.post(
    "/{conversation_id}/interactions/{interaction_id}", response_model=StatusResponse
)
async def resolve_interaction(
    conversation_id: str,
    interaction_id: str,
    user: AuthUser,
    body: ResolveInteractionRequest = Body(discriminator="kind"),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Settle any paused interaction over the unified bridge (§18.2).

    One endpoint for every suspend kind, discriminated on ``body.kind``:

    - ``approval`` — authorize / deny a paused GRANTABLE tool call (the gate
      auto-denies anything left unanswered);
    - ``ask_user`` — the user's checkpoint answer (continue / adjust / stop);
    - ``client_tool`` — a bound desktop's result envelope for a local-workspace op.

    The pending interaction (awaiting in the live ``send_message`` SSE turn) resumes
    with its kind-specific result. 404 if it is unknown, already settled, timed out,
    belongs to another conversation, or its kind does not match — a stale resolve
    falls through as "not found".
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)

    # Per-kind result construction is shared with the sidecar's ``respond`` so cloud
    # and local settle an interaction identically (see ``interaction_result_from_body``).
    result = interaction_result_from_body(body)

    registry = default_interaction_registry()
    pending = registry.get(interaction_id)
    if (
        pending is None
        or pending.conversation_id != conversation_id
        or pending.kind != body.kind
    ):
        raise NotFoundError("交互请求不存在或已处理")
    if not registry.resolve(
        interaction_id, result, conversation_id=conversation_id
    ):
        raise NotFoundError("交互请求不存在或已处理")
    return StatusResponse()
