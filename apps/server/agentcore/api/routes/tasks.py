"""Cross-conversation background task listings."""

from fastapi import APIRouter, Depends, Query

from agentcore.api.dependencies import AuthUser, get_handoff_job_repo
from agentcore.api.schemas import HandoffJobListResponse, HandoffJobSummary
from agentcore.db.repositories import HandoffJobRepository

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("", response_model=HandoffJobListResponse)
async def list_background_tasks(
    user: AuthUser,
    limit: int = Query(default=200, ge=1, le=500),
    job_repo: HandoffJobRepository = Depends(get_handoff_job_repo),
):
    """List the caller's background jobs across all conversations.

    The task center starts with local-to-cloud handoff jobs because they are the
    background work with a durable lifecycle today. The route is deliberately
    account-scoped: opening the center does not require the client to enumerate
    conversations or make one list request per conversation.
    """
    jobs = await job_repo.list_for_user(user.user_id, limit=limit)
    data = [HandoffJobSummary.model_validate(job) for job in jobs]
    return HandoffJobListResponse(data=data, total=len(data))
