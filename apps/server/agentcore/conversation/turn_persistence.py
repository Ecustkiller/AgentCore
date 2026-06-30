"""End-of-turn persistence: assistant row, journal, ledger, telemetry, salvage."""

from agentcore.config import settings
from agentcore.conversation.background import spawn_background
from agentcore.conversation.common import generate_followups as mint_followups
from agentcore.conversation.common import generate_title as mint_title
from agentcore.conversation.common import log_cost_recorded
from agentcore.conversation.compaction import schedule_compaction
from agentcore.core.error_codes import ErrorCode
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import (
    ConversationRepository,
    CostEventRepository,
    MessageRepository,
    TurnMetricsRepository,
)
from agentcore.llm.byok import LLMCredentials
from agentcore.llm.factory import build_provider
from agentcore.memory.consolidation import schedule_consolidation
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    followups_generated,
    title_generated,
)
from agentcore.runtime.journal import journal_entries_from_display_runs, persist_turn_journal
from agentcore.workspace.protocol import WorkspaceBackend
from agentcore.workspace.snapshots import create_snapshot

logger = get_logger(__name__)

_RUN_ERROR_MESSAGE_CAP = 2000

_PAUSE_REQUIRED_TYPES = ("checkpoint_required", "plan_review_required")
_PAUSE_RESOLVED_TYPES = ("checkpoint_resolved", "plan_review_resolved")


def has_open_durable_pause(journal: list[dict]) -> bool:
    """True if the journal ends on an UNRESOLVED plan_review / ask_user checkpoint."""
    required: set[str] = set()
    resolved: set[str] = set()
    for event in journal:
        cid = (event.get("payload") or {}).get("checkpoint_id")
        if not cid:
            continue
        if event.get("type") in _PAUSE_REQUIRED_TYPES:
            required.add(cid)
        elif event.get("type") in _PAUSE_RESOLVED_TYPES:
            resolved.add(cid)
    return bool(required - resolved)


async def persist_turn_result(
    *,
    result: dict,
    conversation_id: str,
    user_id: str,
    folder_id: str | None,
    backend: WorkspaceBackend,
    sink: EventSink,
    user_message: str,
    generate_title: bool,
    llm_credentials: LLMCredentials | None,
    trace_id: str,
    turn_id: str,
    duration_ms: int,
    kind: str = "turn",
) -> None:
    """Persist a completed turn's reply + ledger + telemetry, then title / memory / snapshot."""
    assistant_reply = result.get("content") or ""
    assistant_reasoning = result.get("reasoning_content") or None
    assistant_citations = result.get("citations") or None
    journal_entries = result.get("journal_entries")
    cost_runs = result.get("cost_runs") or []

    finish = result.get("finish_reason")
    finish_value = getattr(finish, "value", finish)
    # 挂起即收口 (②): the turn parked at a durable checkpoint (FinishReason.PAUSED) — its
    # ONLY record is the paused_turns frame the suspending tool persisted before the loop
    # returned. Writing an assistant row / journal / cost / metrics here would create a
    # phantom completed reply and double-count when ``POST .../resume`` later persists the
    # finished turn under this SAME message_id. Nothing to persist until the turn actually
    # ends on resume — mirrors today's blocking pause, where the loop never returned here.
    if finish_value == FinishReason.PAUSED.value:
        logger.info(
            "chat.turn_paused",
            conversation_id=conversation_id,
            message_id=result.get("message_id"),
        )
        return
    turn_error = result.get("error")
    run_error = (
        {
            "code": result.get("error_code") or ErrorCode.PIPELINE_ERROR,
            "message": str(turn_error)[:_RUN_ERROR_MESSAGE_CAP],
        }
        if turn_error
        else None
    )
    abnormal = bool(turn_error) or (
        finish_value is not None and finish_value != FinishReason.END_TURN.value
    )
    synth_entries = (
        journal_entries_from_display_runs(
            {"finish_reason": finish_value, "error": run_error}
        )
        if journal_entries is None and abnormal
        else None
    )
    durable_entries = journal_entries if journal_entries is not None else synth_entries

    async with async_session_factory() as session:
        msg_repo = MessageRepository(session)
        conv_repo = ConversationRepository(session)

        if assistant_reply or abnormal:
            await msg_repo.create(
                conversation_id=conversation_id,
                role="assistant",
                content=assistant_reply,
                reasoning_content=assistant_reasoning,
                citations=assistant_citations,
                message_id=result.get("message_id"),
                trace_id=trace_id,
                metadata={
                    "input_tokens": result.get("input_tokens", 0),
                    "output_tokens": result.get("output_tokens", 0),
                    "reasoning_tokens": result.get("reasoning_tokens", 0),
                    "cache_hit_tokens": result.get("cache_hit_tokens", 0),
                    "cache_miss_tokens": result.get("cache_miss_tokens", 0),
                    "rounds": result.get("rounds", 0),
                },
            )
            await persist_turn_journal(
                session,
                message_id=result.get("message_id"),
                conversation_id=conversation_id,
                trace_id=trace_id,
                entries=durable_entries,
            )

        if cost_runs:
            try:
                await CostEventRepository(session).record_runs(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=result.get("message_id"),
                    runs=cost_runs,
                    trace_id=trace_id,
                )
                log_cost_recorded(conversation_id, result.get("message_id"), cost_runs)
            except Exception as e:
                await session.rollback()
                logger.warning(
                    "cost.ledger_write_failed",
                    conversation_id=conversation_id,
                    message_id=result.get("message_id"),
                    error=str(e),
                )

        workers = max(len(cost_runs) - 1, 0)
        collab = result.get("collab") or {}
        try:
            await TurnMetricsRepository(session).record(
                turn_id=turn_id,
                conversation_id=conversation_id,
                user_id=user_id,
                trace_id=trace_id,
                agent_id="CEO",
                kind=kind,
                status=(
                    "error" if turn_error or finish_value == FinishReason.ERROR.value else "ok"
                ),
                finish_reason=finish_value,
                error=str(turn_error)[:1000] if turn_error else None,
                rounds=int(result.get("rounds", 0) or 0),
                duration_ms=duration_ms,
                delegated=workers > 0,
                workers=workers,
                input_tokens=int(result.get("input_tokens", 0) or 0),
                output_tokens=int(result.get("output_tokens", 0) or 0),
                # 协作质量 (学·度量 §2.5): persisted for the operator面 看板.
                boundary_yields=int(collab.get("boundary_yields", 0) or 0),
                scope_signals=int(collab.get("scope_signals", 0) or 0),
                revises=int(collab.get("revises", 0) or 0),
                escalations=int(collab.get("escalations", 0) or 0),
            )
        except Exception as e:
            await session.rollback()
            logger.warning(
                "observability.turn_metrics_write_failed",
                conversation_id=conversation_id,
                turn_id=turn_id,
                error=str(e),
            )

        conv = await conv_repo.get_by_id(conversation_id)
        needs_title = bool(generate_title and conv and not conv.title)

    # 下一步推荐 (CEO→用户): quick-reply chips for the just-finished turn. Only for a
    # cleanly-ended turn that actually produced a reply — an errored / paused / empty
    # turn has no「what next」to offer (and would distract from its real prompt).
    wants_followups = bool(assistant_reply.strip()) and not abnormal

    # Both are post-turn World B「内部窄任务」on the same fast model — build one provider
    # and run them in sequence so a title-less follow-up turn still gets one client.
    if needs_title or wants_followups:
        provider = build_provider(llm_credentials)
        try:
            if needs_title:
                title = await mint_title(
                    provider=provider,
                    conversation_id=conversation_id,
                    user_message=user_message,
                    assistant_reply=assistant_reply,
                )
                if title:
                    async with async_session_factory() as session:
                        await ConversationRepository(session).update_title(
                            conversation_id, title
                        )
                    sink.emit(title_generated(title, conversation_id=conversation_id))
            if wants_followups:
                followups = await mint_followups(
                    provider=provider,
                    conversation_id=conversation_id,
                    user_message=user_message,
                    assistant_reply=assistant_reply,
                )
                if followups:
                    sink.emit(followups_generated(followups, conversation_id=conversation_id))
        finally:
            await provider.close()

    schedule_consolidation(conversation_id)
    schedule_compaction(conversation_id, result.get("input_tokens", 0))

    if (
        settings.workspace_snapshot_enabled
        and backend.location == "server"
        and getattr(backend, "dirty", False)
    ):
        try:
            snapshot_folder_id = getattr(backend, "folder_id", None) or folder_id
            ref = await create_snapshot(
                user_id=user_id,
                folder_id=snapshot_folder_id,
                conversation_id=conversation_id,
            )
            logger.info(
                "workspace.snapshot_created",
                conversation_id=conversation_id,
                snapshot_id=ref.snapshot_id,
                size_bytes=ref.size_bytes,
            )
        except Exception as e:
            logger.warning(
                "workspace.snapshot_failed",
                conversation_id=conversation_id,
                error=str(e),
            )


async def persist_incomplete_turn(
    *,
    journal: list[dict],
    conversation_id: str,
    trace_id: str,
    message_id: str | None,
) -> None:
    """Persist a cancelled turn's already-finished work as one incomplete message (断线别白干)."""
    note = (
        "（连接中断，本回合未完成。下面是已完成队员的产出，已为你保留；如需继续，可重新发送消息。）"
    )
    try:
        async with async_session_factory() as session:
            msg = await MessageRepository(session).create(
                conversation_id=conversation_id,
                role="assistant",
                content=note,
                metadata={
                    "incomplete": True,
                    "finish_reason": FinishReason.CANCELLED.value,
                },
                message_id=message_id,
                trace_id=trace_id,
            )
            await persist_turn_journal(
                session,
                message_id=msg.id,
                conversation_id=conversation_id,
                trace_id=trace_id,
                entries=journal_entries_from_display_runs(
                    {
                        "events": journal,
                        "finish_reason": FinishReason.CANCELLED.value,
                    }
                ),
            )
        logger.info(
            "chat.incomplete_persisted",
            conversation_id=conversation_id,
            events=len(journal),
        )
    except Exception as e:
        logger.warning(
            "chat.incomplete_persist_failed",
            conversation_id=conversation_id,
            error=str(e),
        )


def salvage_incomplete_turn(
    *,
    sink: EventSink,
    conversation_id: str,
    trace_id: str,
    message_id: str | None = None,
) -> None:
    """On a turn cancel, schedule saving its finished work as an incomplete message."""
    if not settings.incomplete_turn_persist_enabled:
        return
    journal = sink.execution_journal()
    if not journal:
        return
    if settings.structured_suspension_persist_enabled and has_open_durable_pause(journal):
        return
    spawn_background(
        persist_incomplete_turn(
            journal=list(journal),
            conversation_id=conversation_id,
            trace_id=trace_id,
            message_id=message_id,
        )
    )
