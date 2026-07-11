"""Interaction resolution: settle a paused approval / escalation / debate / delegation."""

from fastapi import APIRouter, Body, Depends, HTTPException

from agentcore.api.dependencies import AuthUser, get_conversation_repo
from agentcore.api.schemas import (
    ResolveInteractionRequest,
    StatusResponse,
    interaction_result_from_body,
)
from agentcore.core.errors import NotFoundError
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import ConversationRepository, TurnJournalRepository
from agentcore.runtime.events import (
    approval_resolved,
    debate_round_decision_resolved,
    delegation_authorization_resolved,
    escalation_resolved,
)
from agentcore.runtime.interaction import InteractionKind, default_interaction_registry
from agentcore.runtime.interaction_orphan import emit_orphan_fact
from agentcore.runtime.journal.pending_interactions import fold_pending_interactions
from agentcore.runtime.settlement import already_settled_in_writer, prewrite_settlement
from agentcore.runtime.turn_runs import turn_runs

from ._helpers import _require_owned_conversation

logger = get_logger(__name__)
router = APIRouter(prefix="/conversations", tags=["conversations"])

_HOT_KINDS = frozenset(
    {
        InteractionKind.APPROVAL.value,
        InteractionKind.DELEGATION_AUTHORIZATION.value,
        InteractionKind.ESCALATION.value,
        InteractionKind.DEBATE_ROUND.value,
    }
)


def _settlement_event_for_resolve(
    body: ResolveInteractionRequest,
    interaction_id: str,
    pending_payload: dict | None,
):
    """Build the same ``*_resolved`` SSE the awaiter would emit (D8 同形)."""
    payload = pending_payload or {}
    if body.kind == InteractionKind.APPROVAL.value:
        return approval_resolved(
            approval_id=interaction_id,
            tool_call_id=str(payload.get("tool_call_id") or interaction_id),
            decision=body.decision.value if hasattr(body.decision, "value") else str(body.decision),
        )
    if body.kind == InteractionKind.DELEGATION_AUTHORIZATION.value:
        return delegation_authorization_resolved(
            authorization_id=interaction_id,
            execution_id=str(payload.get("execution_id") or ""),
            decision=body.decision.value if hasattr(body.decision, "value") else str(body.decision),
        )
    if body.kind == InteractionKind.ESCALATION.value:
        use_assumption = bool(getattr(body, "use_assumption", False))
        answer = "" if use_assumption else str(getattr(body, "answer", "") or "")
        status = "assumed" if use_assumption else "resolved"
        return escalation_resolved(
            str(payload.get("run_id") or ""),
            str(payload.get("agent_id") or ""),
            escalation_id=interaction_id,
            status=status,
            answer=answer,
            arbitrated_by="user",
        )
    if body.kind == InteractionKind.DEBATE_ROUND.value:
        return debate_round_decision_resolved(
            execution_id=str(payload.get("execution_id") or ""),
            moderator_run_id=str(payload.get("moderator_run_id") or ""),
            decision_id=interaction_id,
            decision=str(getattr(body, "decision", "continue") or "continue"),
            focus=str(getattr(body, "focus", "") or ""),
        )
    return None


async def _journal_pending_for_id(
    conversation_id: str, interaction_id: str, kind: str
) -> tuple[str | None, dict | None]:
    """Find a journal-fold pending match; returns (turn_id, payload) or (None, None)."""
    # Prefer the live turn's message_id when a run is registered.
    run = turn_runs.get(conversation_id)
    candidate_ids: list[str] = []
    if run is not None:
        mid = getattr(run.sink, "_message_id", None)
        if mid:
            candidate_ids.append(str(mid))

    async with async_session_factory() as db:
        # Also scan recent assistant turns if needed — load by conversation.
        from sqlalchemy import select

        from agentcore.db.models.runs import TurnJournalRow

        if not candidate_ids:
            result = await db.execute(
                select(TurnJournalRow.turn_id)
                .where(TurnJournalRow.conversation_id == conversation_id)
                .order_by(TurnJournalRow.seq.desc())
                .limit(50)
            )
            candidate_ids = list(dict.fromkeys(r for r in result.scalars().all()))

        for turn_id in candidate_ids:
            entries = await TurnJournalRepository(db).load(turn_id)
            for pending in fold_pending_interactions(entries, message_id=turn_id):
                if pending.id == interaction_id and pending.kind == kind:
                    return turn_id, pending.payload
    return None, None


@router.post("/{conversation_id}/interactions/{interaction_id}", response_model=StatusResponse)
async def resolve_interaction(
    conversation_id: str,
    interaction_id: str,
    user: AuthUser,
    body: ResolveInteractionRequest = Body(discriminator="kind"),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Settle any paused interaction over the unified bridge (§8.2).

    Settlement 预写 (D8)：先落库 settlement 事实再 settle Future。journal 有 required、
    无 Future → 写 orphaned + HTTP 410。真正未知 id 仍 404。重复答复幂等返回已处理。
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)

    result = interaction_result_from_body(body)
    registry = default_interaction_registry()
    pending = registry.get(interaction_id)

    if (
        pending is not None
        and pending.conversation_id == conversation_id
        and pending.kind == body.kind
    ):
        if (
            pending.kind.value == "escalation"
            and (pending.payload or {}).get("awaiting") == "ceo"
        ):
            raise NotFoundError("该升级正由主管仲裁，请等待")

        event = _settlement_event_for_resolve(body, interaction_id, pending.payload)
        if event is not None:
            if already_settled_in_writer(event):
                return StatusResponse(status="already_processed")
            try:
                await prewrite_settlement(event)
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "interaction.settlement_prewrite_failed",
                    interaction_id=interaction_id,
                    error=str(e),
                )
                raise HTTPException(
                    status_code=500,
                    detail={"code": "settlement_write_failed"},
                ) from e

        if not registry.resolve(interaction_id, result, conversation_id=conversation_id):
            # Race: already settled between get and resolve — idempotent.
            return StatusResponse(status="already_processed")
        return StatusResponse()

    # Future 不在：查 journal fold 是否仍有 pending → orphan + 410
    if body.kind in _HOT_KINDS:
        turn_id, _payload = await _journal_pending_for_id(
            conversation_id, interaction_id, body.kind
        )
        if turn_id is not None:
            await emit_orphan_fact(
                interaction_id=interaction_id,
                kind=body.kind,
                turn_id=turn_id,
                conversation_id=conversation_id,
                prefer_direct=True,
            )
            raise HTTPException(
                status_code=410,
                detail={"code": "interaction_orphaned"},
            )

    raise NotFoundError("交互请求不存在或已处理")
