"""Conversation CRUD and message sending routes.

Every route requires an authenticated user and is scoped to that user's own
conversations: reads/writes pass ``user_id`` into the repository so a non-owner
receives 404 (never another user's data — IDOR-safe).
"""

import asyncio

from fastapi import APIRouter, Depends, Query

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_message_repo,
)
from agentcore.api.schemas import (
    ConversationListResponse,
    ConversationSummary,
    CreateConversationRequest,
    MessageDetail,
    MessageListResponse,
    RegenerateMessageRequest,
    ResolveCheckpointRequest,
    ResolvePlanReviewRequest,
    SendMessageRequest,
    StatusResponse,
    UpdateConversationRequest,
)
from agentcore.api.sse import sse_response
from agentcore.conversation.service import regenerate_chat, stream_chat
from agentcore.core.errors import NotFoundError
from agentcore.db.repositories import ConversationRepository, MessageRepository
from agentcore.runtime.events import EventSink
from agentcore.runtime.interactions import (
    AgentOverride,
    InteractionResponse,
    interaction_registry,
)

router = APIRouter(prefix="/conversations", tags=["conversations"])


async def _require_owned_conversation(
    conversation_id: str, user_id: str, repo: ConversationRepository
) -> None:
    """404 unless the conversation exists and belongs to the user."""
    conv = await repo.get_by_id(conversation_id, user_id=user_id)
    if not conv:
        raise NotFoundError("Conversation not found")


@router.post("", response_model=ConversationSummary, status_code=201)
async def create_conversation(
    body: CreateConversationRequest,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    conv = await repo.create(user_id=user.user_id, title=body.title)
    return ConversationSummary.model_validate(conv)


@router.get("", response_model=ConversationListResponse)
async def list_conversations(
    user: AuthUser,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    offset = (page - 1) * page_size
    conversations, total = await repo.list_by_user(
        user.user_id, limit=page_size, offset=offset
    )
    return ConversationListResponse(
        data=[ConversationSummary.model_validate(c) for c in conversations],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/{conversation_id}", response_model=ConversationSummary)
async def get_conversation(
    conversation_id: str,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    conv = await repo.get_by_id(conversation_id, user_id=user.user_id)
    if not conv:
        raise NotFoundError("Conversation not found")
    return ConversationSummary.model_validate(conv)


@router.patch("/{conversation_id}", response_model=ConversationSummary)
async def update_conversation(
    conversation_id: str,
    body: UpdateConversationRequest,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    if body.title is not None:
        conv = await repo.update_title(conversation_id, body.title, user_id=user.user_id)
    else:
        conv = await repo.get_by_id(conversation_id, user_id=user.user_id)
    if not conv:
        raise NotFoundError("Conversation not found")
    return ConversationSummary.model_validate(conv)


@router.delete("/{conversation_id}", response_model=StatusResponse)
async def delete_conversation(
    conversation_id: str,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    deleted = await repo.soft_delete(conversation_id, user_id=user.user_id)
    if not deleted:
        raise NotFoundError("Conversation not found")
    return StatusResponse()


@router.get("/{conversation_id}/messages", response_model=MessageListResponse)
async def list_messages(
    conversation_id: str,
    user: AuthUser,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    repo: MessageRepository = Depends(get_message_repo),
):
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    offset = (page - 1) * page_size
    messages, total = await repo.list_by_conversation(
        conversation_id, limit=page_size, offset=offset
    )
    return MessageListResponse(
        data=[MessageDetail.model_validate(m) for m in messages],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("/{conversation_id}/messages")
async def send_message(
    conversation_id: str,
    body: SendMessageRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Send a user message and get a streaming AI response via SSE.

    The pipeline runs as a detached task feeding ``sink``; its handle is passed
    to ``sse_response`` so a client disconnect (e.g. the user hits stop) cancels
    it server-side rather than letting it run to completion unobserved.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)

    sink = EventSink()

    task = asyncio.create_task(
        stream_chat(
            conversation_id=conversation_id,
            user_message=body.content,
            user_id=user.user_id,
            sink=sink,
            attachments=[a.model_dump() for a in body.attachments],
        )
    )

    return sse_response(sink, producer=task)


@router.post("/{conversation_id}/messages/{message_id}/regenerate")
async def regenerate_message(
    conversation_id: str,
    message_id: str,
    body: RegenerateMessageRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Re-run a turn from an existing user message via SSE.

    Serves both "regenerate" (no body content — reuse the stored user text) and
    "edit & resend" (``content`` set — edit the user message first). The target
    ``message_id`` must be a user message; the superseded assistant reply and any
    later turns are dropped before re-running. Like ``send_message``, the pipeline
    runs as a detached task so a client disconnect cancels it server-side.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)

    sink = EventSink()

    task = asyncio.create_task(
        regenerate_chat(
            conversation_id=conversation_id,
            message_id=message_id,
            user_id=user.user_id,
            sink=sink,
            edited_content=body.content,
        )
    )

    return sse_response(sink, producer=task)


@router.post(
    "/{conversation_id}/checkpoints/{checkpoint_id}/resolve",
    response_model=StatusResponse,
)
async def resolve_checkpoint(
    conversation_id: str,
    checkpoint_id: str,
    body: ResolveCheckpointRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Resolve a suspended checkpoint with the user's decision.

    Unblocks the multi-agent run awaiting this interaction. Returns 404 if the
    checkpoint is unknown or already resolved (e.g. timed out).
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    resolved = interaction_registry.resolve(
        checkpoint_id,
        InteractionResponse(action=body.action, feedback=body.feedback),
    )
    if not resolved:
        raise NotFoundError("Checkpoint not found or already resolved")
    return StatusResponse()


@router.post(
    "/{conversation_id}/plan/{review_id}/resolve",
    response_model=StatusResponse,
)
async def resolve_plan_review(
    conversation_id: str,
    review_id: str,
    body: ResolvePlanReviewRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Resolve the pre-execution team-preview gate.

    Unblocks the multi-agent run suspended before scheduling: "start" begins
    execution (applying any per-agent model overrides — tier + reasoning depth),
    "cancel" aborts. Returns 404 if the review is unknown or already resolved
    (e.g. timed out).
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    overrides = (
        {
            agent_id: AgentOverride(
                model_preference=ov.model_preference,
                thinking=ov.thinking,
                reasoning_effort=ov.reasoning_effort,
            )
            for agent_id, ov in body.overrides.items()
        }
        if body.overrides
        else None
    )
    resolved = interaction_registry.resolve(
        review_id,
        InteractionResponse(action=body.action, overrides=overrides),
    )
    if not resolved:
        raise NotFoundError("Plan review not found or already resolved")
    return StatusResponse()
