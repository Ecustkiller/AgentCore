"""User-initiated worker redirect during an active delegate batch (Phase 2a Step 1)."""

from fastapi import APIRouter, Depends

from agentcore.api.dependencies import AuthUser, get_conversation_repo
from agentcore.api.schemas import SubmitRunRedirectRequest, SubmitRunRedirectResponse
from agentcore.core.logging import get_logger
from agentcore.db.repositories import ConversationRepository
from agentcore.runtime.runs.redirect_queue import enqueue_redirect, peek_redirect_count

from ._helpers import _require_owned_conversation

router = APIRouter(prefix="/conversations", tags=["conversations"])

logger = get_logger(__name__)


@router.post("/{conversation_id}/run-redirect", response_model=SubmitRunRedirectResponse)
async def submit_run_redirect(
    conversation_id: str,
    body: SubmitRunRedirectRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Queue a mid-flight redirect for one worker in the current delegate batch.

    The CEO is blocked inside ``delegate`` — this fire-and-forget endpoint is the
  user直控 channel (Step 2: WaveScheduler cancels the run and cold re-starts with
    ``steer``). Step 1 only enqueues and logs from the drive loop.
    """
    await _require_owned_conversation(conv_repo, conversation_id, user.id)
    enqueue_redirect(
        execution_id=body.execution_id,
        run_id=body.run_id,
        feedback=body.feedback,
        conversation_id=conversation_id,
    )
    queued = peek_redirect_count(body.execution_id)
    logger.info(
        "run_redirect.queued",
        conversation_id=conversation_id,
        execution_id=body.execution_id,
        run_id=body.run_id,
        queued=queued,
    )
    return SubmitRunRedirectResponse(queued=queued)
