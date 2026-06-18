"""ConversationService: stream_chat entry point.

Coordinates message persistence, history loading, pipeline execution,
and title generation for a conversation turn.
"""

import asyncio
import time
from collections.abc import Coroutine
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.conversation.compaction import schedule_compaction
from agentcore.conversation.history import load_chat_context
from agentcore.core.errors import AgentCoreError
from agentcore.core.log_context import log_context, new_trace_id
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.db.base import async_session_factory
from agentcore.db.models import Conversation
from agentcore.db.repositories import (
    ConversationRepository,
    CostEventRepository,
    FolderRepository,
    HandoffJobRepository,
    MessageRepository,
    ModelModeRepository,
    TurnMetricsRepository,
    UserRepository,
)
from agentcore.llm.byok import LLMCredentials, resolve_user_llm_credentials
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.factory import build_provider
from agentcore.llm.modes import ProfileSet, resolve_profile_set
from agentcore.memory import (
    TITLE_MAX_CHARS,
    ChatMessage,
    LLMTitleGenerator,
    TitleInput,
)
from agentcore.memory.consolidation import schedule_consolidation
from agentcore.runtime.checkpoints import CheckpointResponse
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    error_event,
    handoff_job_started,
    message_end,
    title_generated,
    turn_saved,
)
from agentcore.runtime.journal import persist_turn_journal
from agentcore.runtime.pipeline import resume_chat_pipeline, run_chat_pipeline
from agentcore.runtime.session_persistence import load_run_session, save_run_session
from agentcore.runtime.suspension import TurnSuspension
from agentcore.runtime.suspension_persistence import (
    delete_paused_turn,
    save_paused_turn,
)
from agentcore.workspace.attachments import persist_attachments, to_stored_metadata
from agentcore.workspace.deferred import DeferredWorkspace, PromotionResult
from agentcore.workspace.handoff import snapshot_local
from agentcore.workspace.locate import (
    LocalBinding,
    build_server_workspace,
    build_workspace,
    default_workspace_name,
    resolve_local_binding,
    workspace_storage_key,
)
from agentcore.workspace.locks import workspace_lock
from agentcore.workspace.protocol import WorkspaceBackend
from agentcore.workspace.snapshots import create_snapshot, restore_into_workspace

logger = get_logger(__name__)


def _log_cost_recorded(conversation_id: str, message_id: str | None, cost_runs: list[dict]) -> None:
    """Emit ``cost.recorded`` after a turn's ledger rows persist successfully.

    Pairs with the existing ``cost.ledger_write_failed`` so spend is visible in the
    log stream (not only in the DB ``cost_events`` table): per-turn run count, total
    spend (integer nano-USD, the storage unit, + a rounded USD view), and the model
    mix. Lets ``log_stats`` surface a cost summary without a DB round-trip.
    """
    total_nano = sum(int(r.get("cost_total_nano", 0) or 0) for r in cost_runs)
    models = sorted({str(r.get("model", "?")) for r in cost_runs})
    logger.info(
        "cost.recorded",
        conversation_id=conversation_id,
        message_id=message_id,
        runs=len(cost_runs),
        total_nano=total_nano,
        total_usd=round(total_nano / 1e9, 6),
        models=models,
    )


def _fallback_title(user_message: str) -> str:
    """Naive title: the first user message, truncated."""
    title = user_message.strip()
    return title[:TITLE_MAX_CHARS] + "…" if len(title) > TITLE_MAX_CHARS else title


def _preview(text: str, *, limit: int = 80) -> str:
    """Single-line, length-capped preview of message text for a log field.

    Collapses whitespace/newlines so one turn stays one readable log line; the
    full content lives in the DB (messages table), never re-dumped to the log.
    """
    collapsed = " ".join((text or "").split())
    return collapsed[:limit] + "…" if len(collapsed) > limit else collapsed


async def _resolve_local_binding(
    session: AsyncSession, conv: Conversation
) -> LocalBinding | None:
    """Resolve a turn's local-mode binding (双模式工作区 §七), or None for cloud.

    Looks up the binding on the conversation's folder (文件夹即工作区: the binding
    lives on the folder, the shared project space). A 裸聊 (no folder) has no
    workspace yet, so it is always cloud. The folder is loaded only when filed; the
    pure ``resolve_local_binding`` applies the rule so this stays a thin DB shim.
    """
    folder = None
    if conv.folder_id:
        folder = await FolderRepository(session).get_by_id(conv.folder_id)
    return resolve_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=folder.local_root_id if folder else None,
        folder_local_subpath=folder.local_subpath if folder else None,
        label=folder.name if folder else None,
    )


# Characters illegal in a single FS path segment (Windows is the strictest, so we
# honor its set everywhere for portability): the reserved set plus control chars.
_SUBPATH_FORBIDDEN = set('<>:"/\\|?*') | {chr(c) for c in range(32)}
_SUBPATH_MAX = 80  # keep on-disk directory names readable, not full 200-char names


def _sanitize_subpath_segment(name: str) -> str:
    """Turn a workspace name into one FS-safe directory segment (工作区对称化 D1a).

    Drops reserved/control characters, collapses whitespace, trims trailing dots /
    spaces (illegal on Windows), and caps length so the on-disk folder under the
    container reads cleanly. Falls back to ``"workspace"`` if nothing survives.
    """
    cleaned = "".join(c for c in name if c not in _SUBPATH_FORBIDDEN)
    cleaned = " ".join(cleaned.split()).rstrip(". ")
    return cleaned[:_SUBPATH_MAX].rstrip(". ") or "workspace"


async def _unique_local_subpath(
    repo: FolderRepository, *, user_id: str, container_root_id: str, name: str
) -> str:
    """A subpath segment for ``name`` not already used by a folder in the container.

    Two bare chats promoted before their titles exist would both want
    "未命名工作区"; sharing one on-disk directory would merge their files. So dedupe
    against the user's existing folders bound to the same container root, suffixing
    ``-2``, ``-3``… on collision. Server-generated (never user input), so it is a
    safe single path segment.
    """
    base = _sanitize_subpath_segment(name)
    folders = await repo.list_by_user(user_id)
    taken = {
        f.local_subpath
        for f in folders
        if f.local_root_id == container_root_id and f.local_subpath
    }
    if base not in taken:
        return base
    i = 2
    while f"{base}-{i}" in taken:
        i += 1
    return f"{base}-{i}"


def _bare_chat_promote(
    *,
    user_id: str,
    conversation_id: str,
    title: str | None,
    user_message: str,
    local_container_root_id: str | None,
):
    """Build the lazy-promotion callback for a 裸聊 turn (文件夹即工作区 §懒建).

    ``DeferredWorkspace`` invokes this the first time the team (or a residency write)
    creates a file: mint a folder named after the chat, file the conversation into
    it, and return where it landed so the rest of the turn — and the end-of-turn
    snapshot — target it. Runs in its own session because it fires mid-run, after the
    turn's setup session has already closed.

    When ``local_container_root_id`` is set (a desktop bare chat, 工作区对称化 D1a),
    the new folder is bound **local** at a unique subpath under that container root,
    so each file-producing desktop chat becomes its own local workspace card —
    symmetric with cloud. Otherwise it is a cloud folder (the original behavior). The
    name comes from the title when available, else the first user message (the title
    is async, usually still absent at this mid-turn moment) — and for local it also
    seeds the on-disk directory, so a meaningful name matters.
    """

    async def _promote() -> PromotionResult:
        name = default_workspace_name(title, fallback_text=user_message)
        local_subpath: str | None = None
        async with async_session_factory() as session:
            repo = FolderRepository(session)
            if local_container_root_id:
                local_subpath = await _unique_local_subpath(
                    repo,
                    user_id=user_id,
                    container_root_id=local_container_root_id,
                    name=name,
                )
            folder = await repo.create(
                user_id=user_id,
                name=name,
                local_root_id=local_container_root_id,
                local_subpath=local_subpath,
            )
            await ConversationRepository(session).set_folder(
                conversation_id, folder.id, user_id=user_id
            )
        binding = (
            LocalBinding(
                root_id=local_container_root_id,
                root_label=name,
                subpath=local_subpath or "",
            )
            if local_container_root_id
            else None
        )
        logger.info(
            "workspace.bare_chat_promoted",
            conversation_id=conversation_id,
            folder_id=folder.id,
            location="local" if binding else "server",
        )
        return PromotionResult(folder_id=folder.id, local_binding=binding)

    return _promote


def _build_turn_backend(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    title: str | None,
    sink: EventSink,
    local_binding: LocalBinding | None,
    user_message: str = "",
    local_container_root_id: str | None = None,
) -> WorkspaceBackend:
    """Pick a turn's workspace backend, deferring creation for a 裸聊 (§懒建).

    A folderless conversation has no workspace yet, so it gets a
    ``DeferredWorkspace`` that materializes a real folder only on the first file
    creation (keeping casual chats zero-cost). ``local_container_root_id`` (a desktop
    bare chat, 工作区对称化 D1a) makes that lazy folder a **local** workspace under
    the container root; without it the chat promotes to cloud. A filed — or
    locally-bound — conversation resolves its backend eagerly via ``build_workspace``
    (cloud/local fork unchanged).
    """
    if folder_id is None and local_binding is None:
        return DeferredWorkspace(
            user_id=user_id,
            promote=_bare_chat_promote(
                user_id=user_id,
                conversation_id=conversation_id,
                title=title,
                user_message=user_message,
                local_container_root_id=local_container_root_id,
            ),
            sink=sink,
            conversation_id=conversation_id,
        )
    return build_workspace(
        user_id=user_id,
        folder_id=folder_id,
        conversation_id=conversation_id,
        sink=sink,
        local_binding=local_binding,
    )


async def _generate_title(
    *,
    provider: DeepSeekProvider,
    conversation_id: str,
    user_message: str,
    assistant_reply: str,
) -> str:
    """Best-effort one-line title via the fast model; falls back to truncation.

    Any failure degrades to the naive truncated title. The provider is owned and
    closed by the caller.
    """
    fallback = _fallback_title(user_message)
    if not user_message.strip():
        return fallback

    messages: list[ChatMessage] = [{"role": "user", "content": user_message}]
    if assistant_reply.strip():
        messages.append({"role": "assistant", "content": assistant_reply})

    try:
        title = await LLMTitleGenerator(provider).generate(
            TitleInput(conversation_id=conversation_id, messages=messages)
        )
        return title or fallback
    except Exception as e:
        logger.warning("chat.title_failed", conversation_id=conversation_id, error=str(e))
        return fallback


async def _resolve_profile_set(
    session: AsyncSession, conv: Conversation, user_id: str
) -> ProfileSet:
    """Resolve this turn's 质量档 (llm/modes.py): conversation override → user default
    → operator default. Loads the user's custom modes so a custom-mode id resolves;
    an unknown/deleted ref falls back to economy inside the resolver. Clamped to the
    operator ceiling (settings.selectable_models)."""
    user = await UserRepository(session).get_by_id(user_id)
    mode_ref = (
        conv.model_mode
        or (user.default_model_mode if user else None)
        or settings.default_model_mode
    )
    custom_modes = await ModelModeRepository(session).assignments_by_user(user_id)
    return resolve_profile_set(
        mode_ref, custom_modes=custom_modes, ceiling=settings.selectable_models
    )


def _session_callbacks(conversation_id: str):
    """The 留人 跨进程落盘 (P3) write-through saver + roster-miss loader, or
    ``(None, None)`` when disabled (P2 in-memory-only). Shared by send / regenerate /
    resume so a finished/revised worker survives a restart for 定向唤回."""
    if not settings.session_roster_persist_enabled:
        return None, None

    async def _persist_session(session) -> None:
        await save_run_session(conversation_id, session)

    return _persist_session, load_run_session


def _suspension_callbacks():
    """The 结构化挂起 2b persist-before-wait / drop-after-resolve closures, or
    ``(None, None)`` when disabled (2a in-memory-only). Threaded into the top-level
    delegate so a plan_review pause survives a disconnect for ``POST .../resume``."""
    if not settings.structured_suspension_persist_enabled:
        return None, None
    return save_paused_turn, delete_paused_turn


async def _run_and_persist(
    *,
    conversation_id: str,
    user_message: str,
    user_id: str,
    folder_id: str | None,
    sink: EventSink,
    history: list[dict],
    attachments: list[dict] | None,
    backend: WorkspaceBackend,
    generate_title: bool,
    llm_credentials: LLMCredentials | None,
    profile_set: ProfileSet | None = None,
) -> None:
    """Run the pipeline, persist the assistant reply, then title + memory.

    Shared tail of both first-time sends and regenerate / edit-and-resend.
    `history` is the prior context (already excluding the current user turn).
    Title generation is skipped for regenerate (the conversation already has one).
    The user turn is persisted and reconciled by the caller before this runs.
    The `backend` is built by the caller (so attachment residency writes onto the
    same instance whose `dirty` flag drives the end-of-turn snapshot).
    """
    session_saver, session_loader = _session_callbacks(conversation_id)
    suspension_saver, suspension_deleter = _suspension_callbacks()

    # Mint the turn's trace_id (the unique cross-everything correlation key) and
    # bind the correlation context so EVERY line emitted during the turn (here, the
    # pipeline, the engine react loop, delegate/tool calls) carries it. AgentCore
    # runs workers in-process, so a delegated worker's task inherits these
    # contextvars automatically — one conversation turn is greppable end-to-end by
    # trace_id (产品AI日志). chat.turn_start / chat.turn_complete bracket it with the
    # message preview + outcome (rounds / tokens / delegated / latency).
    turn_id = new_id()
    # Held in a local because the DB persistence below runs AFTER this log_context
    # exits (the contextvar is cleared by then), yet must stamp the same trace_id
    # onto the assistant message + cost rows so they join back to this turn's logs.
    trace_id = new_trace_id()
    started = time.monotonic()
    with log_context(
        trace_id=trace_id,
        conversation_id=conversation_id,
        user_id=user_id,
        turn_id=turn_id,
        agent_id="CEO",
    ):
        logger.info(
            "chat.turn_start",
            chars=len(user_message or ""),
            preview=_preview(user_message),
            history=len(history),
            attachments=len(attachments or []),
            location=backend.location,
        )
        try:
            result = await run_chat_pipeline(
                conversation_id=conversation_id,
                user_message=user_message,
                history=history,
                sink=sink,
                user_id=user_id,
                backend=backend,
                attachments=attachments,
                llm_credentials=llm_credentials,
                profile_set=profile_set,
                session_saver=session_saver,
                session_loader=session_loader,
                suspension_saver=suspension_saver,
                suspension_deleter=suspension_deleter,
            )
        except asyncio.CancelledError:
            # Client disconnect / user stop tore the turn down before its reply
            # (the SSE layer cancels this task). Salvage any finished team work into
            # an incomplete message so it is not wasted (断线别白干), then let the
            # cancellation propagate — never swallow it.
            _salvage_incomplete_turn(
                sink=sink, conversation_id=conversation_id, trace_id=trace_id
            )
            raise
        finish = result.get("finish_reason")
        cost_runs = result.get("cost_runs") or []
        duration_ms = int((time.monotonic() - started) * 1000)
        logger.info(
            "chat.turn_complete",
            finish_reason=getattr(finish, "value", finish),
            rounds=result.get("rounds", 0),
            input_tokens=result.get("input_tokens", 0),
            output_tokens=result.get("output_tokens", 0),
            reasoning_tokens=result.get("reasoning_tokens", 0),
            reply_chars=len(result.get("content") or ""),
            delegated=bool(result.get("runs")),
            # cost_runs = captain root + one row per delegated member, so members
            # = len - 1 (0 when the CEO answered solo).
            workers=max(len(cost_runs) - 1, 0),
            duration_ms=duration_ms,
            error=result.get("error"),
        )

    await _persist_turn_result(
        result=result,
        conversation_id=conversation_id,
        user_id=user_id,
        folder_id=folder_id,
        backend=backend,
        sink=sink,
        user_message=user_message,
        generate_title=generate_title,
        llm_credentials=llm_credentials,
        trace_id=trace_id,
        turn_id=turn_id,
        duration_ms=duration_ms,
        kind="turn",
    )


async def _persist_turn_result(
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
    """Persist a completed turn's reply + ledger + telemetry, then title / memory / snapshot.

    Shared end-of-turn tail of a fresh send, a regenerate, AND a 结构化挂起 resume —
    each computes its own pipeline ``result`` then hands it here. A resume reuses the
    ORIGINAL ``message_id`` / ``trace_id`` (carried on the frame), so the assistant
    row + ledger it writes for the first time on completion join back to the turn
    that paused. ``generate_title`` is idempotent-guarded (only fires when the
    conversation still lacks a title). ``turn_id`` / ``duration_ms`` / ``kind`` feed
    the 运营观测 telemetry row (admin 观测看板); ``kind`` is "turn" for a fresh send /
    regenerate, "resume" for a 结构化挂起 continuation.
    """
    assistant_reply = result.get("content") or ""
    assistant_reasoning = result.get("reasoning_content") or None
    assistant_citations = result.get("citations") or None
    assistant_runs = result.get("runs") or None
    # 执行级事件溯源 (§18.3): the pre-composed fact-log journal (single source). Present
    # on a fresh send / regenerate (run_chat_pipeline); absent on a resume / salvage,
    # which fall back to flattening ``runs`` in persist_turn_journal.
    journal_entries = result.get("journal_entries")
    cost_runs = result.get("cost_runs") or []

    async with async_session_factory() as session:
        msg_repo = MessageRepository(session)
        conv_repo = ConversationRepository(session)

        if assistant_reply:
            # The pipeline's message id pins the row so the streamed/persisted
            # assistant ids agree on reload.
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
                    "rounds": result.get("rounds", 0),
                },
            )
            # 唯一事实源: record the turn's execution fact stream to the journal,
            # keyed by the assistant message id (§18.3). The replay payload
            # (MessageDetail.runs) is projected back from it on read — no longer
            # stored on the message. Best-effort (never breaks the committed reply).
            await persist_turn_journal(
                session,
                message_id=result.get("message_id"),
                conversation_id=conversation_id,
                trace_id=trace_id,
                runs=assistant_runs,
                entries=journal_entries,
            )

        # 落账: persist the per-run cost ledger for this turn (captain root + one
        # row per delegated member). It shares the pipeline's message_id with the
        # assistant row above, so the payroll (queried by message_id) lines up
        # with the persisted message. The ledger is the truth source for spend
        # (Message.usage is only a display snapshot), so it is written even when
        # no assistant text was produced — the tokens were still spent. A ledger
        # failure must NEVER break the turn (文档铁律): we roll back the aborted
        # cost statement so the session stays usable for the title lookup, then
        # log and move on. The reply is already committed above and is unaffected.
        if cost_runs:
            try:
                await CostEventRepository(session).record_runs(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=result.get("message_id"),
                    runs=cost_runs,
                    trace_id=trace_id,
                )
                _log_cost_recorded(conversation_id, result.get("message_id"), cost_runs)
            except Exception as e:
                await session.rollback()
                logger.warning(
                    "cost.ledger_write_failed",
                    conversation_id=conversation_id,
                    message_id=result.get("message_id"),
                    error=str(e),
                )

        # 运营观测: persist this turn's compact telemetry row (admin 观测看板 数据源).
        # Mirrors what was just logged at chat.turn_complete / chat.resume_complete,
        # but in Postgres so the dashboard aggregates with indexed SQL — the JSONL
        # log file may not exist in prod's stdout-only posture (settings.log_file
        # default ""). Written for EVERY completed turn (ok or soft-error), even
        # one that produced no assistant text. Best-effort: a telemetry write must
        # NEVER break the committed turn (同 cost ledger 铁律) — roll back the aborted
        # statement and move on.
        finish = result.get("finish_reason")
        finish_value = getattr(finish, "value", finish)
        turn_error = result.get("error")
        try:
            await TurnMetricsRepository(session).record(
                turn_id=turn_id,
                conversation_id=conversation_id,
                user_id=user_id,
                trace_id=trace_id,
                agent_id="CEO",
                kind=kind,
                status=(
                    "error"
                    if turn_error or finish_value == FinishReason.ERROR.value
                    else "ok"
                ),
                finish_reason=finish_value,
                error=str(turn_error)[:1000] if turn_error else None,
                rounds=int(result.get("rounds", 0) or 0),
                duration_ms=duration_ms,
                delegated=bool(assistant_runs),
                workers=max(len(cost_runs) - 1, 0),
                input_tokens=int(result.get("input_tokens", 0) or 0),
                output_tokens=int(result.get("output_tokens", 0) or 0),
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

    # Title generation hits the network after the pipeline already emitted
    # message_end, so this latency is not user-visible. The title_generated event is
    # emitted before the sink closes, so the sidebar updates live.
    if needs_title:
        provider = build_provider(llm_credentials)
        try:
            title = await _generate_title(
                provider=provider,
                conversation_id=conversation_id,
                user_message=user_message,
                assistant_reply=assistant_reply,
            )
        finally:
            await provider.close()
        if title:
            async with async_session_factory() as session:
                conv_repo = ConversationRepository(session)
                await conv_repo.update_title(conversation_id, title)
            sink.emit(title_generated(title, conversation_id=conversation_id))

    # Long-term memory is refreshed OFF the turn by the offline consolidation pass
    # (memory/consolidation.py): arm its idle debounce for this conversation so a
    # burst of turns consolidates ONCE — over the whole window, against the existing
    # memory — when the user pauses (水位线+锁 / 防抖+sweeper). Non-blocking; a
    # missed debounce (restart / closed client) is caught by the periodic sweeper.
    schedule_consolidation(conversation_id)

    # 长对话压缩 (执行引擎架构设计 §十三 长对话压缩): when this turn's prompt crossed the
    # token threshold, fold the older turns into the conversation's rolling summary OFF
    # the turn (token-triggered, watermark-gated, computed once & reused so the prefix
    # cache holds). ``input_tokens`` is the turn total (an upper bound on the captain
    # prompt) — a conservative trigger; the pass no-ops if there is nothing old to fold.
    # Non-blocking; a missed fire self-heals on the next over-threshold turn.
    schedule_compaction(conversation_id, result.get("input_tokens", 0))

    # Best-effort workspace backup (决策⑥): if this turn changed files, snapshot
    # the workspace to object storage. It runs after message_end (and the title
    # event) already fired, so it is off the user-visible path; a backup failure
    # must NEVER affect the turn (文档铁律), so it is warning-only. Cloud-mode
    # files already live on the server disk — this is the versioned backup, not
    # the source of truth. Local mode is skipped: those files live on the user's
    # machine, not the server, so there is nothing here to snapshot — the local→云
    # handoff bridge (§四 / P2e) is a separate, explicit path, not this OSS backup.
    if (
        settings.workspace_snapshot_enabled
        and backend.location == "server"
        and getattr(backend, "dirty", False)
    ):
        try:
            # A 裸聊 that wrote files this turn was lazily promoted into a folder
            # (DeferredWorkspace); snapshot that new folder, not the original (None).
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


# Journaled pause events whose presence (unresolved) means a durable frame already
# owns this turn's continuation — so the salvage path must defer to resume, not also
# persist an incomplete message. Approval pauses are deliberately absent: they are
# transport-only (never journaled) and not 2b-resumable, so a turn cancelled at an
# approval IS what salvage covers.
_PAUSE_REQUIRED_TYPES = ("checkpoint_required", "plan_review_required")
_PAUSE_RESOLVED_TYPES = ("checkpoint_resolved", "plan_review_resolved")


def _has_open_durable_pause(journal: list[dict]) -> bool:
    """True if the journal ends on an UNRESOLVED plan_review / ask_user checkpoint.

    Such a turn paused at a durable suspension point: with persistence on, a
    ``paused_turns`` frame already covers its continuation via ``POST .../resume``,
    so salvaging an incomplete message too would double-handle it (a resume card AND
    an incomplete bubble for one turn). A checkpoint with a matching ``*_resolved``
    is closed (the turn moved on), so it does not count.
    """
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


async def _persist_incomplete_turn(
    *,
    journal: list[dict],
    conversation_id: str,
    trace_id: str,
    message_id: str | None,
) -> None:
    """Persist a cancelled turn's already-finished work as one incomplete message (断线别白干).

    The turn was torn down before its reply (disconnect / stop / pending approval),
    but workers that had already finished live on in the execution ``journal`` (each
    emitted ``run_completed`` as it finished). Save that team graph as an assistant
    message marked cancelled — ``runs.finish_reason`` carries the signal the client
    reads on reload (``MessageDetail`` does not expose ``usage``) to badge it「已中断」,
    and a short note explains the bubble. NO cost ledger is written: the authoritative
    per-run ledger is only collected after the wave returns (empty on a mid-wave
    cancel), and reconstructing billing from display events would be fragile — so a
    salvaged turn under-bills rather than risk over-billing. Best-effort: any failure
    is warning-only and never escapes this detached task (文档铁律).
    """
    note = (
        "（连接中断，本回合未完成。下面是已完成队员的产出，已为你保留；"
        "如需继续，可重新发送消息。）"
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
            # 唯一事实源: keep the already-finished team work as the turn's journal
            # (§18.3) so the salvaged bubble replays its graph; finish_reason rides
            # the turn_end fact (the client reads it to badge「已中断」).
            await persist_turn_journal(
                session,
                message_id=msg.id,
                conversation_id=conversation_id,
                trace_id=trace_id,
                runs={
                    "events": journal,
                    "finish_reason": FinishReason.CANCELLED.value,
                },
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


def _salvage_incomplete_turn(
    *,
    sink: EventSink,
    conversation_id: str,
    trace_id: str,
    message_id: str | None = None,
) -> None:
    """On a turn cancel, schedule saving its finished work as an incomplete message.

    Called from the ``CancelledError`` handler of a turn (disconnect / stop): reads
    the surviving execution journal and, if it holds finished team work that is NOT
    already owned by a durable resume frame, fires a detached task to persist it. Sync
    + fire-and-forget on purpose — it must not ``await`` inside cancellation unwinding;
    the detached task carries its own DB session and outlives this teardown (the loop
    stays alive on a client disconnect). Gated by ``incomplete_turn_persist_enabled``.
    """
    if not settings.incomplete_turn_persist_enabled:
        return
    journal = sink.execution_journal()
    # None ⇒ nothing replayable (no delegation / checkpoint) ⇒ no finished work to keep.
    if not journal:
        return
    # A live durable pause is the resume path's job — don't also salvage it.
    if settings.structured_suspension_persist_enabled and _has_open_durable_pause(
        journal
    ):
        return
    _spawn_background(
        _persist_incomplete_turn(
            journal=list(journal),
            conversation_id=conversation_id,
            trace_id=trace_id,
            message_id=message_id,
        )
    )


async def stream_chat(
    *,
    conversation_id: str,
    user_message: str,
    user_id: str,
    sink: EventSink,
    attachments: list[dict] | None = None,
    llm_credentials: LLMCredentials | None = None,
    local_container_root_id: str | None = None,
) -> None:
    """Main entry: persist user message, run pipeline, persist assistant reply.

    Creates its own DB session to avoid lifecycle issues with the HTTP request.

    `attachments` are user-referenced files (@-mention / paperclip). Their text is
    injected into the model context for this turn, and—new in 附件驻留 (决策⑤)—file
    attachments are also written into the workspace under ``attachments/`` so they
    persist as durable, team-readable, downloadable project files; the stored
    message keeps only display metadata + each file's ``workspace_path`` (never the
    raw text), and attachments are still kept out of title/memory generation.

    `local_container_root_id` (工作区对称化 D1a) is the desktop's default local
    container root: when a **裸聊** turn first produces a file, it is lazily promoted
    into a *local* workspace under this root (a per-conversation subpath) instead of
    a cloud folder — so desktop and cloud are symmetric (each file-producing chat is
    its own card). ``None`` (web / mobile / explicit "云端临时对话") keeps the cloud
    lazy-promote. Ignored once the conversation already has a folder.
    """
    try:
        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id(conversation_id)
            if not conv:
                sink.emit(error_event("NOT_FOUND", "Conversation not found"))
                sink.emit(message_end(FinishReason.ERROR))
                return
            folder_id = conv.folder_id
            title = conv.title
            local_binding = await _resolve_local_binding(session, conv)
            profile_set = await _resolve_profile_set(session, conv, user_id)

        # Resolve the workspace once: attachment residency writes, the pipeline
        # run, and the end-of-turn snapshot all share this backend instance (so
        # its `dirty` flag reflects attachments too). The fork lives in
        # `_build_turn_backend`: a 裸聊 gets a ``DeferredWorkspace`` (folder minted
        # lazily on the first file write), a bound desktop root → ``LocalWorkspace``
        # (ops stream over this turn's `sink`), else the server backend. The folder
        # lock + the snapshot guard below adapt to whichever it returns.
        backend = _build_turn_backend(
            user_id=user_id,
            folder_id=folder_id,
            conversation_id=conversation_id,
            title=title,
            sink=sink,
            local_binding=local_binding,
            user_message=user_message,
            local_container_root_id=local_container_root_id,
        )

        # Folder-level lock (决策④): serialize tasks that share this workspace so
        # same-folder turns never interleave file writes / the snapshot manifest.
        # Held for the whole turn — including attachment residency and persisting
        # the user row — so a queued same-folder turn waits here. The worker team
        # inside runs in parallel, unaffected.
        async with workspace_lock(
            workspace_storage_key(
                user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
            )
        ):
            # 附件驻留: write file attachments into the workspace; the returned
            # list carries each persisted file's workspace_path for the context
            # block and the stored metadata.
            resident_attachments = await persist_attachments(backend, attachments)

            async with async_session_factory() as session:
                user_msg = await MessageRepository(session).create(
                    conversation_id=conversation_id,
                    role="user",
                    content=user_message,
                    attachments=to_stored_metadata(resident_attachments),
                )
                history = await load_chat_context(
                    session, conversation_id, max_messages=40
                )

            # Reconcile the optimistic user bubble to its real row id, so a retry
            # after a mid-stream failure regenerates from the saved turn rather
            # than resending it (which would duplicate the user message).
            sink.emit(turn_saved(user_message_id=user_msg.id))

            await _run_and_persist(
                conversation_id=conversation_id,
                user_message=user_message,
                user_id=user_id,
                folder_id=folder_id,
                sink=sink,
                history=history[:-1],
                attachments=resident_attachments,
                backend=backend,
                generate_title=True,
                llm_credentials=llm_credentials,
                profile_set=profile_set,
            )

    except Exception as e:
        logger.error("chat.stream_error", error=str(e), exc_info=True)
        # A top-level failure (DB / workspace / lock) here used to die silently:
        # the stream closed with no terminal event, so the client spun on a
        # "thinking" bubble forever. Surface a visible, retriable error and a
        # terminal message_end before the finally closes the sink, so the bubble
        # settles into an inline error card (mirrors the NOT_FOUND path above).
        if not sink._closed:
            if isinstance(e, AgentCoreError):
                sink.emit(error_event(e.code, e.message))
            else:
                sink.emit(error_event("STREAM_ERROR", "服务出错了，请稍后重试。"))
            sink.emit(message_end(FinishReason.ERROR))
    finally:
        if not sink._closed:
            sink.close()


async def _recorded_turn_response(
    *, conversation_id: str, user_message_id: str, message_id: str | None
) -> dict:
    """Build ``record_local_turn``'s response from already-persisted rows (a retry hit).

    The turn was recorded by an earlier call whose response the desktop never saw;
    return the same ids it would have, so the optimistic bubbles reconcile against the
    real rows instead of spawning a duplicate turn. The current title rides along (the
    desktop syncs its sidebar cache) — we cannot tell whether this very turn minted it,
    and syncing to the authoritative title is always safe.
    """
    async with async_session_factory() as session:
        assistant_id: str | None = None
        if message_id:
            assistant = await MessageRepository(session).get_by_id(
                message_id, conversation_id=conversation_id
            )
            assistant_id = assistant.id if assistant else None
        conv = await ConversationRepository(session).get_by_id(conversation_id)
    return {
        "user_message_id": user_message_id,
        "assistant_message_id": assistant_id,
        "title": conv.title if conv else None,
    }


async def record_local_turn(
    *,
    conversation_id: str,
    user_id: str,
    user_message: str,
    assistant_content: str,
    assistant_reasoning: str | None = None,
    citations: list[dict] | None = None,
    runs: dict | None = None,
    user_message_id: str | None = None,
    message_id: str | None = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    rounds: int = 0,
    llm_credentials: LLMCredentials | None = None,
) -> dict:
    """Persist a turn that ran on the user's machine via the sidecar (双模式工作区 §一.1).

    The local engine produced the reply on the user's box — no server pipeline ran —
    so the desktop reports the finished turn here to land it in durable history (入库
    / 跨设备). Mirrors ``stream_chat``'s persistence tail (user row + assistant row +
    journal + idempotent title) but WITHOUT a live ``sink`` (a plain REST call, not an
    SSE turn) and WITHOUT a workspace snapshot (local files live on the user's disk;
    the local→云 handoff is the separate explicit bridge). Returns the persisted ids
    (+ any newly minted title) so the desktop reconciles its optimistic bubbles.

    计费: NOT recorded here — a sidecar turn's LLM calls are metered authoritatively at
    the cloud inference proxy (``/v1/inference``, Slice 4a) as they happen, so this
    write-back persists content only (no client-reported ledger to double-bill).

    回写可靠性 (双模式工作区 §一.1): the desktop wraps this POST in a bounded retry, so a
    retry after a response we DID commit must NOT duplicate the turn. ``user_message_id``
    (the client-minted user-bubble id) makes the whole write-back idempotent: it is
    pinned as the persisted user row's id, and if a row with it already exists the turn
    was recorded — we return the persisted ids (+ current title) without re-creating.
    """
    trace_id = new_trace_id()
    with log_context(trace_id=trace_id, conversation_id=conversation_id, user_id=user_id):
        # Idempotency fast path: a retried write-back whose user row already landed is a
        # no-op — return the persisted ids so the desktop reconciles against the same
        # rows the first (lost-response) call created, never a duplicate turn.
        if user_message_id:
            async with async_session_factory() as session:
                already = await MessageRepository(session).get_by_id(
                    user_message_id, conversation_id=conversation_id
                )
            if already is not None:
                logger.info(
                    "chat.local_turn_idempotent_hit",
                    conversation_id=conversation_id,
                    message_id=message_id,
                )
                return await _recorded_turn_response(
                    conversation_id=conversation_id,
                    user_message_id=user_message_id,
                    message_id=message_id,
                )

        # Pin the user row to the client id so the idempotency check above sees it on a
        # retry. A concurrent retry that beat us here trips the unique id → IntegrityError;
        # treat that race as the same idempotent hit.
        try:
            async with async_session_factory() as session:
                user_msg = await MessageRepository(session).create(
                    conversation_id=conversation_id,
                    role="user",
                    content=user_message,
                    message_id=user_message_id,
                )
        except IntegrityError:
            logger.info(
                "chat.local_turn_idempotent_race",
                conversation_id=conversation_id,
                message_id=message_id,
            )
            return await _recorded_turn_response(
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                message_id=message_id,
            )

        # An empty reply (a tool-only / errored local turn) still persists the user
        # row above; only skip the assistant row when there is nothing to show.
        assistant_message_id: str | None = None
        if assistant_content:
            async with async_session_factory() as session:
                assistant_msg = await MessageRepository(session).create(
                    conversation_id=conversation_id,
                    role="assistant",
                    content=assistant_content,
                    reasoning_content=assistant_reasoning,
                    citations=citations,
                    message_id=message_id,
                    trace_id=trace_id,
                    metadata={
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "rounds": rounds,
                    },
                )
                assistant_message_id = assistant_msg.id
                # 唯一事实源: the local engine relays the same replay payload; record
                # it to the journal keyed by the assistant id (§18.3), same as cloud.
                await persist_turn_journal(
                    session,
                    message_id=assistant_msg.id,
                    conversation_id=conversation_id,
                    trace_id=trace_id,
                    runs=runs,
                )

        # Spend is metered at the cloud inference proxy (Slice 4a), so a sidecar turn
        # carries no client-reported ledger to record here — persistence is content-only.
        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id(conversation_id)
            needs_title = bool(conv and not conv.title)

        title: str | None = None
        if needs_title:
            provider = build_provider(llm_credentials)
            try:
                title = await _generate_title(
                    provider=provider,
                    conversation_id=conversation_id,
                    user_message=user_message,
                    assistant_reply=assistant_content,
                )
            finally:
                await provider.close()
            if title:
                async with async_session_factory() as session:
                    await ConversationRepository(session).update_title(
                        conversation_id, title
                    )

        # Refresh long-term memory off the turn (same idle debounce as stream_chat).
        schedule_consolidation(conversation_id)

        logger.info(
            "chat.local_turn_recorded",
            conversation_id=conversation_id,
            message_id=message_id,
            chars=len(assistant_content or ""),
            rounds=rounds,
        )
        return {
            "user_message_id": user_msg.id,
            "assistant_message_id": assistant_message_id,
            "title": title,
        }


async def regenerate_chat(
    *,
    conversation_id: str,
    message_id: str,
    user_id: str,
    sink: EventSink,
    edited_content: str | None = None,
    llm_credentials: LLMCredentials | None = None,
) -> None:
    """Re-run a turn from an existing user message (regenerate / edit-and-resend).

    `message_id` must be a user message in this conversation. When `edited_content`
    is given the message is edited in place first; then every message created after
    it is dropped and the assistant reply is produced anew. Attachments are not
    re-injected (their extracted text is never persisted), and the conversation
    title is left untouched.
    """
    try:
        async with async_session_factory() as session:
            conv_repo = ConversationRepository(session)
            msg_repo = MessageRepository(session)

            conv = await conv_repo.get_by_id(conversation_id)
            if not conv:
                sink.emit(error_event("NOT_FOUND", "Conversation not found"))
                sink.emit(message_end(FinishReason.ERROR))
                return

            target = await msg_repo.get_by_id(message_id, conversation_id=conversation_id)
            if not target or target.role != "user":
                sink.emit(error_event("INVALID", "Can only regenerate from a user message"))
                sink.emit(message_end(FinishReason.ERROR))
                return

            if edited_content is not None:
                await msg_repo.update_content(message_id, edited_content)

            # Drop the superseded assistant reply (and any later turns).
            await msg_repo.delete_after(conversation_id, after_created_at=target.created_at)

            user_message = edited_content if edited_content is not None else (target.content or "")
            history = await load_chat_context(session, conversation_id, max_messages=40)
            local_binding = await _resolve_local_binding(session, conv)
            profile_set = await _resolve_profile_set(session, conv, user_id)

        backend = _build_turn_backend(
            user_id=user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            title=conv.title,
            sink=sink,
            local_binding=local_binding,
        )

        # Folder-level lock (决策④): same workspace serialization as stream_chat.
        async with workspace_lock(
            workspace_storage_key(
                user_id=user_id,
                folder_id=conv.folder_id,
                conversation_id=conversation_id,
            )
        ):
            await _run_and_persist(
                conversation_id=conversation_id,
                user_message=user_message,
                user_id=user_id,
                folder_id=conv.folder_id,
                sink=sink,
                history=history[:-1],
                attachments=None,
                backend=backend,
                generate_title=False,
                llm_credentials=llm_credentials,
                profile_set=profile_set,
            )

    except Exception as e:
        logger.error("chat.regenerate_error", error=str(e), exc_info=True)
        # Same silent-death guard as stream_chat: surface a visible error so the
        # regenerate bubble settles into an inline error card instead of spinning.
        if not sink._closed:
            if isinstance(e, AgentCoreError):
                sink.emit(error_event(e.code, e.message))
            else:
                sink.emit(error_event("STREAM_ERROR", "服务出错了，请稍后重试。"))
            sink.emit(message_end(FinishReason.ERROR))
    finally:
        if not sink._closed:
            sink.close()


async def resume_chat(
    *,
    suspension: TurnSuspension,
    response: CheckpointResponse,
    sink: EventSink,
    llm_credentials: LLMCredentials | None = None,
) -> None:
    """Continue a turn paused at a plan_review / ask_user checkpoint (结构化挂起 2b resume).

    The route has already CLAIMED (atomic read-and-delete) the durable frame, so this
    drives it to completion: rebuild the turn's workspace, run the resume pipeline
    (apply the user's decision to the paused frame by kind — re-drive the plan tail
    for plan_review, or map the answer back to the CEO loop for ask_user — and finish
    the reply), then persist via the shared turn tail — the assistant row + ledger are
    written for the FIRST time here, under the original ``message_id`` / ``trace_id``
    so they join the turn that paused. A downstream checkpoint can pause again: the
    pipeline re-persists a fresh frame, so resume is re-entrant. Mirrors
    ``stream_chat``'s lock / error / sink discipline.
    """
    conversation_id = suspension.conversation_id
    user_id = suspension.user_id
    try:
        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id(conversation_id)
            if not conv:
                sink.emit(error_event("NOT_FOUND", "Conversation not found"))
                sink.emit(message_end(FinishReason.ERROR))
                return
            folder_id = conv.folder_id
            title = conv.title
            local_binding = await _resolve_local_binding(session, conv)
            profile_set = await _resolve_profile_set(session, conv, user_id)
            # Reload the prior context exactly as a fresh send does (load_chat_context
            # then drop the trailing current-user turn): the §18.3 journal stores only
            # history's LENGTH, so resume re-supplies the messages to splice into the
            # rebuilt CEO window (window_from_journal, Phase 2 ④). No new turn landed
            # while the turn was paused, so this tails the same window the original saw.
            history = await load_chat_context(
                session, conversation_id, max_messages=40
            )

        backend = _build_turn_backend(
            user_id=user_id,
            folder_id=folder_id,
            conversation_id=conversation_id,
            title=title,
            sink=sink,
            local_binding=local_binding,
        )
        session_saver, session_loader = _session_callbacks(conversation_id)
        suspension_saver, suspension_deleter = _suspension_callbacks()

        # Folder-level lock (决策④): the resumed tail runs the team + writes files on
        # the shared workspace, so serialize it against any same-folder turn exactly
        # like a fresh send.
        async with workspace_lock(
            workspace_storage_key(
                user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
            )
        ):
            # Reuse the originating turn's trace_id so the resumed continuation is
            # greppable as ONE turn end-to-end (falls back to a fresh id if untraced).
            trace_id = suspension.trace_id or new_trace_id()
            turn_id = new_id()
            started = time.monotonic()
            with log_context(
                trace_id=trace_id,
                conversation_id=conversation_id,
                user_id=user_id,
                turn_id=turn_id,
                agent_id="CEO",
            ):
                logger.info(
                    "chat.resume_start",
                    message_id=suspension.message_id,
                    kind=suspension.kind.value,
                    decision=response.decision.value,
                    # plan_review carries seeded workers; ask_user has none (0).
                    seeded=len(getattr(suspension, "completed", {})),
                )
                try:
                    result = await resume_chat_pipeline(
                        suspension=suspension,
                        decision=response.decision,
                        note=response.note,
                        selected=response.selected,
                        sink=sink,
                        backend=backend,
                        history=history[:-1],
                        llm_credentials=llm_credentials,
                        profile_set=profile_set,
                        session_saver=session_saver,
                        session_loader=session_loader,
                        suspension_saver=suspension_saver,
                        suspension_deleter=suspension_deleter,
                    )
                except asyncio.CancelledError:
                    # A resume torn down before its reply: salvage the finished work
                    # (pre-pause graph + any new members) under the ORIGINAL message id
                    # so it stays one turn, unless it re-paused durably (resume owns
                    # that). Then propagate the cancellation.
                    _salvage_incomplete_turn(
                        sink=sink,
                        conversation_id=conversation_id,
                        trace_id=trace_id,
                        message_id=suspension.message_id,
                    )
                    raise
                finish = result.get("finish_reason")
                cost_runs = result.get("cost_runs") or []
                duration_ms = int((time.monotonic() - started) * 1000)
                logger.info(
                    "chat.resume_complete",
                    finish_reason=getattr(finish, "value", finish),
                    rounds=result.get("rounds", 0),
                    reply_chars=len(result.get("content") or ""),
                    delegated=bool(result.get("runs")),
                    workers=max(len(cost_runs) - 1, 0),
                    duration_ms=duration_ms,
                    error=result.get("error"),
                )

            await _persist_turn_result(
                result=result,
                conversation_id=conversation_id,
                user_id=user_id,
                folder_id=folder_id,
                backend=backend,
                sink=sink,
                user_message=suspension.user_message,
                generate_title=True,
                llm_credentials=llm_credentials,
                trace_id=trace_id,
                turn_id=turn_id,
                duration_ms=duration_ms,
                kind="resume",
            )

    except Exception as e:
        logger.error("chat.resume_error", error=str(e), exc_info=True)
        if not sink._closed:
            if isinstance(e, AgentCoreError):
                sink.emit(error_event(e.code, e.message))
            else:
                sink.emit(error_event("STREAM_ERROR", "服务出错了，请稍后重试。"))
            sink.emit(message_end(FinishReason.ERROR))
    finally:
        if not sink._closed:
            sink.close()


# --- Local→云 handoff: dispatch a cloud team run (双模式工作区 P2e / e2) ---

# Detached background tasks (handoff cloud runs) kept referenced so the event loop
# does not garbage-collect them mid-flight; each removes itself when done. State is
# in-process (single-worker posture, as approvals / channel / locks); a process
# restart drops in-flight jobs (they stay "running" — acceptable for the MVP, front
# with a durable queue to survive restarts).
_background_tasks: set[asyncio.Task] = set()


def _spawn_background(coro: Coroutine[Any, Any, None]) -> asyncio.Task:
    """Fire-and-forget a coroutine, holding a reference until it completes."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


async def _persist_job_turn(
    *, user_id: str, conversation_id: str, result: dict
) -> None:
    """Persist a handoff job's assistant reply + cost ledger under the job conv.

    Same shape as the interactive turn's persistence (message + 落账), minus title
    / memory / auto-snapshot: the job is headless, doesn't touch the user's
    long-term memory, and its result is snapshotted explicitly by the caller. So
    opening the hidden job conversation replays the team graph + payroll exactly
    like a normal multi-agent turn. A ledger failure is warning-only (文档铁律).
    """
    assistant_reply = result.get("content") or ""
    cost_runs = result.get("cost_runs") or []
    async with async_session_factory() as session:
        if assistant_reply:
            await MessageRepository(session).create(
                conversation_id=conversation_id,
                role="assistant",
                content=assistant_reply,
                reasoning_content=result.get("reasoning_content") or None,
                citations=result.get("citations") or None,
                message_id=result.get("message_id"),
                metadata={
                    "input_tokens": result.get("input_tokens", 0),
                    "output_tokens": result.get("output_tokens", 0),
                    "rounds": result.get("rounds", 0),
                },
            )
            # 唯一事实源: the job conversation replays the team graph from the journal
            # like any turn (§18.3). The handoff job runs the full pipeline, so it
            # carries the fact-log journal (single source); fall back to ``runs`` if
            # absent. Untraced (handoff jobs carry no log trace).
            await persist_turn_journal(
                session,
                message_id=result.get("message_id"),
                conversation_id=conversation_id,
                trace_id=None,
                runs=result.get("runs") or None,
                entries=result.get("journal_entries"),
            )
        if cost_runs:
            try:
                await CostEventRepository(session).record_runs(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=result.get("message_id"),
                    runs=cost_runs,
                )
                _log_cost_recorded(conversation_id, result.get("message_id"), cost_runs)
            except Exception as e:
                await session.rollback()
                logger.warning(
                    "handoff.cost_ledger_failed",
                    conversation_id=conversation_id,
                    error=str(e),
                )


async def run_handoff_job(
    *,
    job_id: str,
    user_id: str,
    source_folder_id: str | None,
    source_conversation_id: str,
    job_conversation_id: str,
    base_snapshot_id: str,
    task: str,
    llm_credentials: LLMCredentials | None = None,
) -> None:
    """Run a dispatched cloud team on the local snapshot, detached (P2e / e2).

    Owns its DB sessions (it outlives the dispatch request). Restores the source's
    base snapshot into the hidden job conversation's server workspace, runs the team
    there **un-gated** (autonomous, isolated sandbox — no client to answer
    approvals), persists its task + reply + cost ledger under the job conversation
    (so the run replays), snapshots the result, and marks the job succeeded. Any
    failure marks the job failed with the error — the run is fully self-contained,
    so a crash never escapes onto the event loop.

    ``llm_credentials`` are resolved once by the dispatcher (the user's own BYOK
    key) and threaded in, so the headless run bills the dispatching user; ``None``
    falls back to the platform key.
    """
    async with async_session_factory() as session:
        await HandoffJobRepository(session).mark_running(job_id)
        # The task as the job conversation's user turn, so the replay reads
        # [user task] → [team output] like any conversation.
        await MessageRepository(session).create(
            conversation_id=job_conversation_id, role="user", content=task
        )

    sink = EventSink()
    try:
        await restore_into_workspace(
            source_user_id=user_id,
            source_folder_id=source_folder_id,
            source_conversation_id=source_conversation_id,
            snapshot_id=base_snapshot_id,
            dest_user_id=user_id,
            dest_folder_id=None,
            dest_conversation_id=job_conversation_id,
        )
        backend = build_server_workspace(
            user_id=user_id, folder_id=None, conversation_id=job_conversation_id
        )
        result = await run_chat_pipeline(
            conversation_id=job_conversation_id,
            user_message=task,
            history=[],
            sink=sink,
            user_id=user_id,
            backend=backend,
            approvals_enabled=False,
            llm_credentials=llm_credentials,
        )
        await _persist_job_turn(
            user_id=user_id, conversation_id=job_conversation_id, result=result
        )
        result_ref = await create_snapshot(
            user_id=user_id,
            folder_id=None,
            conversation_id=job_conversation_id,
            label=f"result:{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
        )
        async with async_session_factory() as session:
            await HandoffJobRepository(session).mark_succeeded(
                job_id, result_snapshot_id=result_ref.snapshot_id
            )
        logger.info(
            "handoff.job_succeeded",
            job_id=job_id,
            job_conversation_id=job_conversation_id,
            result_snapshot_id=result_ref.snapshot_id,
        )
    except Exception as e:
        logger.error("handoff.job_failed", job_id=job_id, error=str(e), exc_info=True)
        async with async_session_factory() as session:
            await HandoffJobRepository(session).mark_failed(job_id, error=str(e))
    finally:
        if not sink._closed:
            sink.close()


async def dispatch_handoff(
    *,
    conversation_id: str,
    user_id: str,
    folder_id: str | None,
    binding: LocalBinding,
    task: str,
    sink: EventSink,
) -> None:
    """Snapshot the local workspace, then spawn the cloud team run (P2e / e2).

    Runs over the dispatch SSE ``sink``: first the e1 ARCHIVE → base snapshot (the
    bound desktop fulfils the op), then a hidden ``mode="handoff"`` job conversation
    and a ``HandoffJob`` row are created and the autonomous team run is spawned as a
    detached background task that outlives this request. A ``handoff_job_started``
    is emitted so the client can poll the job; any failure before spawn surfaces as
    an inline ``error`` event. The SSE then closes — the cloud run continues past it.
    """
    try:
        base_ref = await snapshot_local(
            user_id=user_id,
            folder_id=folder_id,
            conversation_id=conversation_id,
            binding=binding,
            sink=sink,
        )
        async with async_session_factory() as session:
            job_conv = await ConversationRepository(session).create(
                user_id=user_id,
                title=_fallback_title(task) or "云端作业",
                mode="handoff",
            )
            job = await HandoffJobRepository(session).create(
                user_id=user_id,
                source_conversation_id=conversation_id,
                job_conversation_id=job_conv.id,
                base_snapshot_id=base_ref.snapshot_id,
                task=task,
            )
            # Resolve the dispatcher's BYOK key once and thread it into the detached
            # job so the cloud run bills the user (None → platform key fallback).
            credentials = await resolve_user_llm_credentials(session, user_id)

        _spawn_background(
            run_handoff_job(
                job_id=job.id,
                user_id=user_id,
                source_folder_id=folder_id,
                source_conversation_id=conversation_id,
                job_conversation_id=job_conv.id,
                base_snapshot_id=base_ref.snapshot_id,
                task=task,
                llm_credentials=credentials,
            )
        )
        sink.emit(
            handoff_job_started(
                job_id=job.id,
                conversation_id=conversation_id,
                job_conversation_id=job_conv.id,
            )
        )
    except Exception as e:
        logger.warning(
            "handoff.dispatch_failed", conversation_id=conversation_id, error=str(e)
        )
        sink.emit(error_event("HANDOFF_DISPATCH_FAILED", str(e)))
    finally:
        if not sink._closed:
            sink.close()
