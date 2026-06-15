"""ConversationService: stream_chat entry point.

Coordinates message persistence, history loading, pipeline execution,
and title generation for a conversation turn.
"""

import asyncio
import time
from collections.abc import Coroutine
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.conversation.history import load_history
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
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    error_event,
    handoff_job_started,
    message_end,
    title_generated,
    turn_saved,
)
from agentcore.runtime.pipeline import run_chat_pipeline
from agentcore.runtime.session_persistence import load_run_session, save_run_session
from agentcore.workspace.attachments import persist_attachments, to_stored_metadata
from agentcore.workspace.handoff import snapshot_local
from agentcore.workspace.locate import (
    LocalBinding,
    build_server_workspace,
    build_workspace,
    resolve_local_binding,
    workspace_storage_key,
)
from agentcore.workspace.locks import workspace_lock
from agentcore.workspace.protocol import WorkspaceBackend
from agentcore.workspace.snapshots import create_snapshot, restore_into_workspace

logger = get_logger(__name__)


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

    Looks up the governing scope's desktop-root binding: the conversation's folder
    when it is filed in one (the shared project space), else the conversation's
    own. The folder is loaded only when needed; the pure ``resolve_local_binding``
    applies the precedence rule so this stays a thin DB shim.
    """
    folder = None
    if conv.folder_id:
        folder = await FolderRepository(session).get_by_id(conv.folder_id)
    return resolve_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=folder.local_root_id if folder else None,
        conversation_local_root_id=conv.local_root_id,
        label=folder.name if folder else None,
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
    # 留人 跨进程落盘 (P3): write-through finished / revised worker sessions and load
    # them back on an in-memory roster miss, so 定向唤回 survives a restart / eviction.
    # Gated off → callbacks stay None and the roster is P2 in-memory-only.
    session_saver = None
    session_loader = None
    if settings.session_roster_persist_enabled:

        async def _persist_session(session) -> None:
            await save_run_session(conversation_id, session)

        session_saver = _persist_session
        session_loader = load_run_session

    # Mint the turn's trace_id (the unique cross-everything correlation key) and
    # bind the correlation context so EVERY line emitted during the turn (here, the
    # pipeline, the engine react loop, delegate/tool calls) carries it. AgentCore
    # runs workers in-process, so a delegated worker's task inherits these
    # contextvars automatically — one conversation turn is greppable end-to-end by
    # trace_id (产品AI日志). chat.turn_start / chat.turn_complete bracket it with the
    # message preview + outcome (rounds / tokens / delegated / latency).
    turn_id = new_id()
    started = time.monotonic()
    with log_context(
        trace_id=new_trace_id(),
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
        )
        finish = result.get("finish_reason")
        cost_runs = result.get("cost_runs") or []
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
            duration_ms=int((time.monotonic() - started) * 1000),
            error=result.get("error"),
        )

    assistant_reply = result.get("content") or ""
    assistant_reasoning = result.get("reasoning_content") or None
    assistant_citations = result.get("citations") or None
    assistant_runs = result.get("runs") or None
    cost_runs = result.get("cost_runs") or []

    async with async_session_factory() as session:
        msg_repo = MessageRepository(session)
        conv_repo = ConversationRepository(session)

        if assistant_reply:
            await msg_repo.create(
                conversation_id=conversation_id,
                role="assistant",
                content=assistant_reply,
                reasoning_content=assistant_reasoning,
                citations=assistant_citations,
                # The team graph (when the CEO delegated) and the pipeline's
                # message id, so a past multi-agent turn replays on reload and
                # the streamed/persisted assistant ids agree.
                runs=assistant_runs,
                message_id=result.get("message_id"),
                metadata={
                    "input_tokens": result.get("input_tokens", 0),
                    "output_tokens": result.get("output_tokens", 0),
                    "rounds": result.get("rounds", 0),
                },
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
                )
            except Exception as e:
                await session.rollback()
                logger.warning(
                    "cost.ledger_write_failed",
                    conversation_id=conversation_id,
                    message_id=result.get("message_id"),
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
            ref = await create_snapshot(
                user_id=user_id,
                folder_id=folder_id,
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


async def stream_chat(
    *,
    conversation_id: str,
    user_message: str,
    user_id: str,
    sink: EventSink,
    attachments: list[dict] | None = None,
    llm_credentials: LLMCredentials | None = None,
) -> None:
    """Main entry: persist user message, run pipeline, persist assistant reply.

    Creates its own DB session to avoid lifecycle issues with the HTTP request.

    `attachments` are user-referenced files (@-mention / paperclip). Their text is
    injected into the model context for this turn, and—new in 附件驻留 (决策⑤)—file
    attachments are also written into the workspace under ``attachments/`` so they
    persist as durable, team-readable, downloadable project files; the stored
    message keeps only display metadata + each file's ``workspace_path`` (never the
    raw text), and attachments are still kept out of title/memory generation.
    """
    try:
        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id(conversation_id)
            if not conv:
                sink.emit(error_event("NOT_FOUND", "Conversation not found"))
                sink.emit(message_end(FinishReason.ERROR))
                return
            folder_id = conv.folder_id
            local_binding = await _resolve_local_binding(session, conv)
            profile_set = await _resolve_profile_set(session, conv, user_id)

        # Resolve the workspace once: attachment residency writes, the pipeline
        # run, and the end-of-turn snapshot all share this backend instance (so
        # its `dirty` flag reflects attachments too). The cloud/local fork lives in
        # `build_workspace`: a bound desktop root → ``LocalWorkspace`` (ops stream
        # over this turn's `sink`), else the server backend. The folder lock + the
        # snapshot guard below adapt to whichever it returns.
        backend = build_workspace(
            user_id=user_id,
            folder_id=folder_id,
            conversation_id=conversation_id,
            sink=sink,
            local_binding=local_binding,
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
                history = await load_history(session, conversation_id, max_messages=40)

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
    finally:
        if not sink._closed:
            sink.close()


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
            history = await load_history(session, conversation_id, max_messages=40)
            local_binding = await _resolve_local_binding(session, conv)
            profile_set = await _resolve_profile_set(session, conv, user_id)

        backend = build_workspace(
            user_id=user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
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
                runs=result.get("runs") or None,
                message_id=result.get("message_id"),
                metadata={
                    "input_tokens": result.get("input_tokens", 0),
                    "output_tokens": result.get("output_tokens", 0),
                    "rounds": result.get("rounds", 0),
                },
            )
        if cost_runs:
            try:
                await CostEventRepository(session).record_runs(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=result.get("message_id"),
                    runs=cost_runs,
                )
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
