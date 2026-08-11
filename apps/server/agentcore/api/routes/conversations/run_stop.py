"""User-initiated per-worker stop during an active delegate batch (只停这项工作)."""

from fastapi import APIRouter, Depends

from agentcore.api.dependencies import AuthUser, get_conversation_repo
from agentcore.api.schemas import SubmitRunStopRequest, SubmitRunStopResponse
from agentcore.core.logging import get_logger
from agentcore.db.repositories import ConversationRepository
from agentcore.runtime.runs.stop_queue import enqueue_stop, peek_stop_count

from ._helpers import _require_owned_conversation

router = APIRouter(prefix="/conversations", tags=["conversations"])

logger = get_logger(__name__)


@router.post("/{conversation_id}/run-stop", response_model=SubmitRunStopResponse)
async def submit_run_stop(
    conversation_id: str,
    body: SubmitRunStopRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Queue a mid-flight stop for one or all workers in the current delegate batch.

    The CEO is blocked inside ``delegate`` — this fire-and-forget endpoint is the
    user直控 channel (same posture as ``run-redirect``). Unlike redirect, stop never
    triggers hot revision or cold ``_redir``; WaveScheduler cancels / withdraws
    targets so drive converges and the CEO keeps the turn.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    enqueue_stop(
        execution_id=body.execution_id,
        run_id=body.run_id,
        conversation_id=conversation_id,
    )
    queued = peek_stop_count(body.execution_id)
    logger.info(
        "run_stop.queued",
        conversation_id=conversation_id,
        execution_id=body.execution_id,
        run_id=body.run_id,
        queued=queued,
    )
    return SubmitRunStopResponse(queued=queued)
