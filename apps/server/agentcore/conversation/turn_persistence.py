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
from agentcore.llm.factory import build_provider
from agentcore.llm.resolve import LLMCredentials, resolve_credentials
from agentcore.llm.resolve import resolve_turn_model as resolve_user_model
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

# Progressive assistant-row lifecycle (stored in Message.usage alongside token fields).
MESSAGE_STATUS_RUNNING = "running"
MESSAGE_STATUS_COMPLETE = "complete"
MESSAGE_STATUS_INCOMPLETE = "incomplete"
MESSAGE_STATUS_FAILED = "failed"

_PAUSE_REQUIRED_TYPES = ("checkpoint_required", "plan_review_required")
_PAUSE_RESOLVED_TYPES = ("checkpoint_resolved", "plan_review_resolved")


def _usage_metadata(
    result: dict,
    *,
    status: str,
    extra: dict | None = None,
) -> dict:
    meta = {
        "status": status,
        "input_tokens": result.get("input_tokens", 0),
        "output_tokens": result.get("output_tokens", 0),
        "reasoning_tokens": result.get("reasoning_tokens", 0),
        "cache_hit_tokens": result.get("cache_hit_tokens", 0),
        "cache_miss_tokens": result.get("cache_miss_tokens", 0),
        "rounds": result.get("rounds", 0),
    }
    if extra:
        meta.update(extra)
    return meta


async def create_assistant_placeholder(
    *,
    conversation_id: str,
    message_id: str,
    trace_id: str,
) -> None:
    """Create the running assistant row at turn start (progressive persistence)."""
    try:
        async with async_session_factory() as session:
            await MessageRepository(session).create_assistant_placeholder(
                conversation_id=conversation_id,
                message_id=message_id,
                trace_id=trace_id,
            )
    except Exception as e:
        logger.warning(
            "chat.assistant_placeholder_failed",
            conversation_id=conversation_id,
            message_id=message_id,
            error=str(e),
        )


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
    if finish_value == FinishReason.PAUSED.value:
        # 挂起即收口 (②): write a best-effort assistant snapshot so a refresh replays the
        # CEO text / reasoning / tool timeline (journal facts were appended on emit; the row
        # is the projection anchor). Cost / metrics / title /
        # followups wait until resume completes; resume updates this same message_id.
        logger.info(
            "chat.turn_paused",
            conversation_id=conversation_id,
            message_id=result.get("message_id"),
        )
        message_id = result.get("message_id")
        if message_id:
            try:
                async with async_session_factory() as session:
                    await MessageRepository(session).upsert_assistant(
                        conversation_id=conversation_id,
                        message_id=message_id,
                        content=assistant_reply,
                        reasoning_content=assistant_reasoning,
                        citations=assistant_citations,
                        trace_id=trace_id,
                        metadata=_usage_metadata(
                            result,
                            status=MESSAGE_STATUS_RUNNING,
                            extra={"paused": True},
                        ),
                    )
            except Exception as e:
                logger.warning(
                    "chat.pause_snapshot_failed",
                    conversation_id=conversation_id,
                    message_id=message_id,
                    error=str(e),
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
    message_id = result.get("message_id")
    terminal_status = (
        MESSAGE_STATUS_FAILED
        if turn_error or finish_value == FinishReason.ERROR.value
        else MESSAGE_STATUS_COMPLETE
    )

    async with async_session_factory() as session:
        msg_repo = MessageRepository(session)
        conv_repo = ConversationRepository(session)

        if message_id:
            await msg_repo.upsert_assistant(
                conversation_id=conversation_id,
                message_id=message_id,
                content=assistant_reply,
                reasoning_content=assistant_reasoning,
                citations=assistant_citations,
                trace_id=trace_id,
                metadata=_usage_metadata(result, status=terminal_status),
            )
            if durable_entries is not None:
                await persist_turn_journal(
                    session,
                    message_id=message_id,
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
                audit_drops=int(result.get("audit_drops", 0) or 0),
            )
        except Exception as e:
            await session.rollback()
            logger.warning(
                "observability.turn_metrics_write_failed",
                conversation_id=conversation_id,
                turn_id=turn_id,
                error=str(e),
            )

        conv = await conv_repo.get_by_id_unscoped(conversation_id)
        needs_title = bool(generate_title and conv and not conv.title)

    # 下一步推荐 (CEO→用户): quick-reply chips for the just-finished turn. Only for a
    # cleanly-ended turn that actually produced a reply — an errored / paused / empty
    # turn has no「what next」to offer (and would distract from its real prompt).
    wants_followups = bool(assistant_reply.strip()) and not abnormal

    # Both are post-turn World B「内部窄任务」— platform key when configured, else BYOK.
    if needs_title or wants_followups:
        async with async_session_factory() as session:
            bg_credentials = await resolve_credentials(session, user_id, "platform_internal")
        model = resolve_user_model(bg_credentials)
        provider = build_provider(bg_credentials, purpose="platform_internal")
        try:
            if needs_title:
                title = await mint_title(
                    provider=provider,
                    conversation_id=conversation_id,
                    user_message=user_message,
                    assistant_reply=assistant_reply,
                    model=model,
                )
                if title:
                    async with async_session_factory() as session:
                        await ConversationRepository(session).update_title_unscoped(
                            conversation_id, title
                        )
                    sink.emit(title_generated(title, conversation_id=conversation_id))
            if wants_followups:
                followups = await mint_followups(
                    provider=provider,
                    conversation_id=conversation_id,
                    user_message=user_message,
                    assistant_reply=assistant_reply,
                    model=model,
                )
                message_id = result.get("message_id")
                if followups and message_id:
                    # DERIVED 持久化 (twin of the title above): write the chips onto this
                    # assistant row so reopening the conversation replays them, THEN emit the
                    # live event. Mirrors the title's persist-then-signal order.
                    async with async_session_factory() as session:
                        await MessageRepository(session).set_followups(
                            message_id,
                            conversation_id=conversation_id,
                            followups=followups,
                        )
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
            ref = await create_snapshot(
                user_id=user_id,
                folder_id=None,
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


_INCOMPLETE_NOTE = (
    "（连接中断，本回合未完成。下面是已完成队员的产出，已为你保留；如需继续，可重新发送消息。）"
)
_INCOMPLETE_SUFFIX = "\n\n（连接中断，本回合未完成——以上为已生成部分；如需继续，可重新发送消息。）"


async def persist_incomplete_turn(
    *,
    journal: list[dict],
    content: str,
    conversation_id: str,
    trace_id: str,
    message_id: str | None,
) -> None:
    """Persist a cancelled turn's already-streamed reply + finished work (断线别白干).

    ``content`` is the CEO bubble text the user already saw (best-effort, may be ""). When
    present it becomes the salvaged message body (marked cut-off) so a mid-stream cancel keeps
    the partial answer instead of a bare「连接中断」note; when empty we fall back to the note
    (the finished-worker journal is the record). Either way the journal is persisted for replay.
    """
    streamed = (content or "").strip()
    body = f"{streamed}{_INCOMPLETE_SUFFIX}" if streamed else _INCOMPLETE_NOTE
    if not message_id:
        logger.warning(
            "chat.incomplete_persist_skipped",
            conversation_id=conversation_id,
            reason="no_message_id",
        )
        return
    try:
        async with async_session_factory() as session:
            await MessageRepository(session).upsert_assistant(
                conversation_id=conversation_id,
                message_id=message_id,
                content=body,
                trace_id=trace_id,
                metadata={
                    "status": MESSAGE_STATUS_INCOMPLETE,
                    "incomplete": True,
                    "finish_reason": FinishReason.CANCELLED.value,
                },
            )
            await persist_turn_journal(
                session,
                message_id=message_id,
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
            content_chars=len(streamed),
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
    """On a turn cancel, schedule saving its streamed reply + finished work as one message.

    Salvages when there is EITHER finished team work (a replayable journal) OR the CEO had
    streamed some reply text — so a cancelled pure-text answer (no team/tool journal surface)
    is no longer silently dropped. Skips a turn parked at an unresolved durable checkpoint
    (its paused frame is the record).
    """
    if not settings.incomplete_turn_persist_enabled:
        return
    if not message_id:
        return
    journal = sink.execution_journal()
    content = sink.streamed_content()
    if not journal and not content.strip():
        return
    suspend_frames = settings.structured_suspension_persist_enabled
    if journal and suspend_frames and has_open_durable_pause(journal):
        return
    spawn_background(
        persist_incomplete_turn(
            journal=list(journal) if journal else [],
            content=content,
            conversation_id=conversation_id,
            trace_id=trace_id,
            message_id=message_id,
        )
    )
