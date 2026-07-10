"""Turn re-execution and durable resume: regenerate / list paused / resume (结构化挂起)."""

import asyncio

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_db,
)
from agentcore.api.schemas import (
    PausedTurnSummary,
    PendingApprovalSummary,
    RegenerateMessageRequest,
    ResumeTurnRequest,
    RetryFailedRequest,
    TurnRecoveryResponse,
)
from agentcore.api.sse import sse_response
from agentcore.conversation.rate_limit import enforce_user_message_rate_limit
from agentcore.conversation.service import regenerate_chat, resume_chat, retry_failed_chat
from agentcore.core.errors import NotFoundError
from agentcore.db.repositories import ConversationRepository
from agentcore.runtime.checkpoints import CheckpointResponse
from agentcore.runtime.events import EventSink
from agentcore.runtime.interaction import InteractionKind, default_interaction_registry
from agentcore.runtime.suspension import TurnSuspension, suspension_summary_fields
from agentcore.runtime.suspension_persistence import (
    claim_paused_turn,
    list_paused_turns,
)
from agentcore.runtime.turn_runs import turn_runs

from ._helpers import (
    _preflight_owned_chat_turn,
    _require_owned_conversation,
    emit_preflight_warnings,
    release_request_db_before_sse,
)

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _paused_summary(f: TurnSuspension) -> PausedTurnSummary:
    """Project one persisted suspension frame to its wire summary (shared by the
    paused-list + recovery endpoints). Kind-specific slots come from the shared
    :func:`~agentcore.runtime.suspension.suspension_summary_fields` codec registry
    (same source as the sidecar ``paused_summary``)."""
    return PausedTurnSummary(
        message_id=f.message_id,
        kind=f.kind,
        checkpoint_id=f.checkpoint_id,
        user_message=f.user_message,
        **suspension_summary_fields(f),
    )


def _pending_approval_summaries(conversation_id: str) -> list[PendingApprovalSummary]:
    """In-process GRANTABLE tool gates still awaiting a user decision."""
    registry = default_interaction_registry()
    return [
        PendingApprovalSummary(
            approval_id=req.id,
            conversation_id=req.conversation_id,
            tool_call_id=str(req.payload.get("tool_call_id") or ""),
            tool_name=str(req.payload.get("tool_name") or ""),
            arguments=dict(req.payload.get("arguments") or {}),
        )
        for req in registry.list_pending(conversation_id)
        if req.kind is InteractionKind.APPROVAL
    ]


@router.post("/{conversation_id}/messages/{message_id}/regenerate")
async def regenerate_message(
    conversation_id: str,
    message_id: str,
    body: RegenerateMessageRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
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

    preflight = await _preflight_owned_chat_turn(conversation_id, user, session)
    await release_request_db_before_sse(session)

    sink = EventSink()
    emit_preflight_warnings(sink, preflight)

    task = asyncio.create_task(
        regenerate_chat(
            conversation_id=conversation_id,
            message_id=message_id,
            user_id=user.user_id,
            sink=sink,
            edited_content=body.content,
            llm_credentials=preflight.credentials,
            llm_supports_tools=preflight.supports_tools,
        )
    )
    turn_runs.register(conversation_id=conversation_id, task=task, sink=sink)

    return sse_response(sink, detach_on_disconnect=True)


@router.post("/{conversation_id}/messages/{message_id}/retry-failed")
async def retry_failed_message(
    conversation_id: str,
    message_id: str,
    _body: RetryFailedRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
):
    """Retry only the failed worker nodes from a previous turn's execution.

    Unlike regenerate (which re-runs everything), this extracts the completed
    worker states from the previous turn's journal and seeds them into a new
    pipeline run, so only failed nodes are re-executed.
    """
    await enforce_user_message_rate_limit(user.user_id)

    preflight = await _preflight_owned_chat_turn(
        conversation_id, user, session, needs_tools=True
    )
    await release_request_db_before_sse(session)

    sink = EventSink()
    emit_preflight_warnings(sink, preflight)

    task = asyncio.create_task(
        retry_failed_chat(
            conversation_id=conversation_id,
            message_id=message_id,
            user_id=user.user_id,
            sink=sink,
            llm_credentials=preflight.credentials,
            llm_supports_tools=preflight.supports_tools,
        )
    )
    turn_runs.register(conversation_id=conversation_id, task=task, sink=sink)

    return sse_response(sink, detach_on_disconnect=True)


@router.get("/{conversation_id}/recovery", response_model=TurnRecoveryResponse)
async def get_conversation_recovery(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """One-shot recovery snapshot for a conversation reopen (recovery 统一, 对称 §8.2).

    Folds the two reopen probes — is a detached run still live (实时重连续看 1b)? are there
    durably paused turns (结构化挂起 2b)? — into a single owner-gated read so the client picks
    ONE actionable surface without racing two endpoints. The client attaches (``GET .../stream``)
    only when ``live_running`` and ``paused`` is empty; otherwise a paused turn's resume card is
    its single surface. ``live_running`` mirrors the attach endpoint's own liveness test (a
    registered run whose task is not done).

    挂起即收口 (②): a checkpoint turn now FINALIZES (SUSPEND→PAUSED, the run ends) rather than
    parking, so a paused turn is durable-only — the former live∩paused 冷热重叠 (a run parked on
    its interaction while its frame also persisted) now survives ONLY as the rare §六-1 thin-net
    (a frame that could not be saved keeps a bounded backend wait). Reporting both fields still
    resolves that rare overlap — and a non-paused detached run (1b) — to the one right surface.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    run = turn_runs.get(conversation_id)
    live_running = run is not None and not run.task.done()
    frames = await list_paused_turns(conversation_id)
    return TurnRecoveryResponse(
        live_running=live_running,
        paused=[_paused_summary(f) for f in frames],
        pending_approvals=_pending_approval_summaries(conversation_id),
    )


@router.post("/{conversation_id}/messages/{message_id}/resume")
async def resume_message(
    conversation_id: str,
    message_id: str,
    body: ResumeTurnRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
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

    preflight = await _preflight_owned_chat_turn(conversation_id, user, session)
    await release_request_db_before_sse(session)

    suspension = await claim_paused_turn(message_id, conversation_id=conversation_id)
    if suspension is None:
        raise NotFoundError("挂起的回合不存在或已处理")

    # The durable frame is now ours (claim succeeded ⇒ this really is a paused turn). 挂起即收口
    # (②): the normal finalized turn's run has already ENDED, so this is usually a no-op — keep it
    # as a safety drain. If any prior run for this conversation is still alive (a not-yet-torn-down
    # finalize, an in-flight attach/reconnect, or the rare §六-1 thin-net backend wait parked on its
    # interaction holding the folder workspace_lock), tear it down BEFORE the resume run takes that
    # same lock — else they could deadlock on it, or the old run later double-continue the turn.
    # Cancel leaves the (already-claimed) frame alone.
    await turn_runs.stop_and_drain(conversation_id)

    sink = EventSink()
    emit_preflight_warnings(sink, preflight)
    task = asyncio.create_task(
        resume_chat(
            suspension=suspension,
            response=CheckpointResponse(
                decision=body.decision, note=body.note, selected=body.selected
            ),
            sink=sink,
            llm_credentials=preflight.credentials,
            llm_supports_tools=preflight.supports_tools,
        )
    )
    # 执行与请求解耦 (C1 · slice 1a): track the resumed run so a disconnect lets it
    # finish + persist and 停止 routes through POST .../stop, same as a fresh send.
    turn_runs.register(conversation_id=conversation_id, task=task, sink=sink)
    return sse_response(sink, detach_on_disconnect=True)
