"""ConversationService: stream_chat entry point.

Coordinates message persistence, history loading, pipeline execution,
and title generation for a conversation turn.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.conversation.history import load_history
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.models import Conversation
from agentcore.db.repositories import (
    ConversationRepository,
    CostEventRepository,
    FolderRepository,
    MessageRepository,
)
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.factory import build_provider
from agentcore.memory import (
    TITLE_MAX_CHARS,
    ChatMessage,
    LLMMemoryExtractor,
    LLMTitleGenerator,
    TitleInput,
    default_memory_store,
    maintain_user_memory,
)
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    error_event,
    message_end,
    title_generated,
    turn_saved,
)
from agentcore.runtime.pipeline import run_chat_pipeline
from agentcore.workspace.attachments import persist_attachments, to_stored_metadata
from agentcore.workspace.locate import (
    LocalBinding,
    build_workspace,
    resolve_local_binding,
    workspace_storage_key,
)
from agentcore.workspace.locks import workspace_lock
from agentcore.workspace.protocol import WorkspaceBackend
from agentcore.workspace.snapshots import create_snapshot

logger = get_logger(__name__)


def _fallback_title(user_message: str) -> str:
    """Naive title: the first user message, truncated."""
    title = user_message.strip()
    return title[:TITLE_MAX_CHARS] + "…" if len(title) > TITLE_MAX_CHARS else title


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

    Any failure degrades to the naive truncated title. The provider is shared by
    the caller (also used for memory maintenance) and closed there.
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
        logger.warning("title_generation_failed", conversation_id=conversation_id, error=str(e))
        return fallback


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
) -> None:
    """Run the pipeline, persist the assistant reply, then title + memory.

    Shared tail of both first-time sends and regenerate / edit-and-resend.
    `history` is the prior context (already excluding the current user turn).
    Title generation is skipped for regenerate (the conversation already has one).
    The user turn is persisted and reconciled by the caller before this runs.
    The `backend` is built by the caller (so attachment residency writes onto the
    same instance whose `dirty` flag drives the end-of-turn snapshot).
    """
    result = await run_chat_pipeline(
        conversation_id=conversation_id,
        user_message=user_message,
        history=history,
        sink=sink,
        user_id=user_id,
        backend=backend,
        attachments=attachments,
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
                    "cost_ledger_write_failed",
                    conversation_id=conversation_id,
                    message_id=result.get("message_id"),
                    error=str(e),
                )

        conv = await conv_repo.get_by_id(conversation_id)
        needs_title = bool(generate_title and conv and not conv.title)

    # Title + long-term memory both hit the network and run after the pipeline
    # already emitted message_end, so this latency is not user-visible. They
    # share one provider. The title_generated event is emitted before the sink
    # closes, so the sidebar updates live.
    provider = build_provider()
    try:
        if needs_title:
            title = await _generate_title(
                provider=provider,
                conversation_id=conversation_id,
                user_message=user_message,
                assistant_reply=assistant_reply,
            )
            if title:
                async with async_session_factory() as session:
                    conv_repo = ConversationRepository(session)
                    await conv_repo.update_title(conversation_id, title)
                sink.emit(title_generated(title, conversation_id=conversation_id))

        # Per-turn long-term memory maintenance from this exchange. Skips the
        # write when nothing durable changed; never raises.
        if user_message.strip():
            turn: list[ChatMessage] = [{"role": "user", "content": user_message}]
            if assistant_reply.strip():
                turn.append({"role": "assistant", "content": assistant_reply})
            await maintain_user_memory(
                user_id=user_id,
                messages=turn,
                extractor=LLMMemoryExtractor(provider),
                store=default_memory_store(),
            )
    finally:
        await provider.close()

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
                "workspace_snapshot_created",
                conversation_id=conversation_id,
                snapshot_id=ref.snapshot_id,
                size_bytes=ref.size_bytes,
            )
        except Exception as e:
            logger.warning(
                "workspace_snapshot_failed",
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
            )

    except Exception as e:
        logger.error("stream_chat_error", error=str(e), exc_info=True)
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
            )

    except Exception as e:
        logger.error("regenerate_chat_error", error=str(e), exc_info=True)
    finally:
        if not sink._closed:
            sink.close()
