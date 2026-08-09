"""Cloud-replica reclaim for handoff job hosts (§7.6 按任务临时、结束可收).

After apply or discard (or retention aging of an open finished job), the hidden
``mode="handoff"`` job conversation is soft-deleted so the existing workspace
retention sweep can hard-purge its scratch + snapshots. This is **not** an
immediate destroy — soft-delete starts the ``workspace_retention_days`` grace;
Diff remains usable while snapshots are still on disk.

Honesty: we never claim the replica vanishes the moment the cloud run finishes,
and we never soft-delete an open (unapplied/undiscarded) job early just because
it succeeded — that would break Diff inside the retention window.
"""

from __future__ import annotations

from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import ConversationRepository, HandoffJobRepository

logger = get_logger(__name__)


async def soft_delete_job_host(*, user_id: str, job_conversation_id: str) -> bool:
    """Soft-delete the hidden job conversation so retention can reclaim its workspace.

    Idempotent: already-deleted / unknown hosts return False without error.
    """
    async with async_session_factory() as session:
        deleted = await ConversationRepository(session).soft_delete(
            job_conversation_id, user_id=user_id
        )
    if deleted:
        logger.info(
            "handoff.host_soft_deleted",
            job_conversation_id=job_conversation_id,
            user_id=user_id,
        )
    return deleted


async def reclaim_after_apply(*, job_id: str, user_id: str, job_conversation_id: str) -> None:
    """Mark the job applied and soft-delete its cloud host (apply success path)."""
    async with async_session_factory() as session:
        await HandoffJobRepository(session).mark_applied(job_id)
    await soft_delete_job_host(user_id=user_id, job_conversation_id=job_conversation_id)


async def reclaim_after_discard(*, job_id: str, user_id: str, job_conversation_id: str) -> bool:
    """Mark discarded + soft-delete host. Returns False if the job was not open."""
    async with async_session_factory() as session:
        ok = await HandoffJobRepository(session).mark_discarded(job_id)
    if not ok:
        return False
    await soft_delete_job_host(user_id=user_id, job_conversation_id=job_conversation_id)
    return True
