"""Turn re-execution and durable resume: regenerate / list paused / resume (结构化挂起)."""

import asyncio

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_cost_event_repo,
    get_db,
)
from agentcore.api.schemas import (
    PausedTurnListResponse,
    PausedTurnSummary,
    RegenerateMessageRequest,
    ResumeTurnRequest,
)
from agentcore.api.sse import sse_response
from agentcore.conversation.rate_limit import enforce_user_message_rate_limit
from agentcore.conversation.service import regenerate_chat, resume_chat
from agentcore.core.errors import NotFoundError
from agentcore.db.repositories import ConversationRepository, CostEventRepository
from agentcore.runtime.checkpoints import CheckpointResponse
from agentcore.runtime.events import EventSink
from agentcore.runtime.suspension_persistence import (
    claim_paused_turn,
    list_paused_turns,
)
from agentcore.runtime.turn_runs import turn_runs

from ._helpers import _preflight_turn_llm, _require_owned_conversation

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.post("/{conversation_id}/messages/{message_id}/regenerate")
async def regenerate_message(
    conversation_id: str,
    message_id: str,
    body: RegenerateMessageRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
):
    """Re-run a turn from an existing user message via SSE.

    Serves both "regenerate" (no body content — reuse the stored user text) and
    "edit & resend" (``content`` set — edit the user message first). The target
    ``message_id`` must be a user message; the superseded assistant reply and any
    later turns are dropped before re-running. Like ``send_message``, the pipeline
    runs as a detached task tracked in the ``TurnRunRegistry`` and the SSE only
    attaches (执行与请求解耦 C1 · slice 1a): a disconnect lets it finish + persist,
    an explicit 停止 goes through ``POST .../stop``. A re-run is a fresh turn, so it
    passes the same gates (rate limit → ownership → BYOK/quota billing gate) as
    ``send_message``.
    """
    await enforce_user_message_rate_limit(user.user_id)
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    credentials = await _preflight_turn_llm(
        session=session, user=user, cost_repo=cost_repo
    )

    sink = EventSink()

    task = asyncio.create_task(
        regenerate_chat(
            conversation_id=conversation_id,
            message_id=message_id,
            user_id=user.user_id,
            sink=sink,
            edited_content=body.content,
            llm_credentials=credentials,
        )
    )
    turn_runs.register(conversation_id=conversation_id, task=task, sink=sink)

    return sse_response(sink, detach_on_disconnect=True)


@router.get("/{conversation_id}/paused", response_model=PausedTurnListResponse)
async def list_conversation_paused_turns(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """List turns awaiting resume after a durable plan_review / ask_user pause (结构化挂起 2b).

    Called on conversation reopen: a turn that paused then lost its live SSE
    (disconnect / restart) has no assistant message yet — only a persisted frame.
    The client renders each as a resume card by ``kind`` (plan_review from ``steps`` /
    ``pending``; ask_user from ``question`` + the optional ``assumptions`` /
    ``questions`` / ``style_options``) offering continue / adjust / stop → the resume
    endpoint. Oldest-first. 404 if not owned.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    frames = await list_paused_turns(conversation_id)
    data = [
        PausedTurnSummary(
            message_id=f.message_id,
            kind=f.kind,
            checkpoint_id=f.checkpoint_id,
            user_message=f.user_message,
            # plan_review fields (empty on an ask_user frame) ...
            steps=getattr(f, "steps", []),
            pending=getattr(f, "pending", []),
            # ... and ask_user fields (empty on a plan_review frame).
            question=getattr(f, "question", ""),
            context=getattr(f, "context", ""),
            assumptions=getattr(f, "assumptions", []),
            questions=getattr(f, "questions", []),
            style_options=getattr(f, "style_options", []),
        )
        for f in frames
    ]
    return PausedTurnListResponse(data=data, total=len(data))


@router.post("/{conversation_id}/messages/{message_id}/resume")
async def resume_message(
    conversation_id: str,
    message_id: str,
    body: ResumeTurnRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
):
    """Continue a durably-paused turn via SSE (结构化挂起 2b ``POST .../resume``).

    The turn paused at a plan_review / ask_user checkpoint and lost its live stream
    (disconnect / restart); only its persisted frame survived. Claims the frame
    (atomic read-and-delete, so a turn is never resumed twice — a second / stale call
    404s), then drives the rest of the turn on a fresh SSE just like a send.
    ``body.selected`` carries the user's ask_user picks (ignored for plan_review).
    Gated like ``send_message`` (it spends tokens): rate limit → ownership → BYOK/quota
    — all BEFORE the claim, so a refused turn keeps its resumable frame.
    """
    await enforce_user_message_rate_limit(user.user_id)
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    credentials = await _preflight_turn_llm(
        session=session, user=user, cost_repo=cost_repo
    )

    suspension = await claim_paused_turn(message_id, conversation_id=conversation_id)
    if suspension is None:
        raise NotFoundError("挂起的回合不存在或已处理")

    sink = EventSink()
    task = asyncio.create_task(
        resume_chat(
            suspension=suspension,
            response=CheckpointResponse(
                decision=body.decision, note=body.note, selected=body.selected
            ),
            sink=sink,
            llm_credentials=credentials,
        )
    )
    # 执行与请求解耦 (C1 · slice 1a): track the resumed run so a disconnect lets it
    # finish + persist and 停止 routes through POST .../stop, same as a fresh send.
    turn_runs.register(conversation_id=conversation_id, task=task, sink=sink)
    return sse_response(sink, detach_on_disconnect=True)
