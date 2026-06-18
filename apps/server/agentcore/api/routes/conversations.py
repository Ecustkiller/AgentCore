"""Conversation CRUD and message sending routes.

Every route requires an authenticated user and is scoped to that user's own
conversations: reads/writes pass ``user_id`` into the repository so a non-owner
receives 404 (never another user's data — IDOR-safe).
"""

import asyncio
import mimetypes
from datetime import datetime

from fastapi import APIRouter, Body, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_cost_event_repo,
    get_db,
    get_folder_repo,
    get_handoff_job_repo,
    get_message_repo,
    get_model_mode_repo,
    get_turn_journal_repo,
)
from agentcore.api.routes.model_modes import validate_mode_ref
from agentcore.api.schemas import (
    ApplyHandoffRequest,
    BindLocalWorkspaceRequest,
    CloneRepoRequest,
    CloneRepoResponse,
    ConversationListResponse,
    ConversationSummary,
    CreateConversationRequest,
    CreateDirRequest,
    CreateSnapshotRequest,
    DispatchHandoffRequest,
    FolderGroup,
    GroupedConversationsResponse,
    HandoffDiffResponse,
    HandoffFileChange,
    HandoffJobListResponse,
    HandoffJobSummary,
    MessageDetail,
    MessageListResponse,
    MoveConversationRequest,
    MoveFileRequest,
    PausedTurnListResponse,
    PausedTurnSummary,
    RecordTurnRequest,
    RecordTurnResponse,
    RegenerateMessageRequest,
    ResolveInteractionRequest,
    ResumeTurnRequest,
    RunsPayload,
    SendMessageRequest,
    SnapshotListResponse,
    SnapshotSummary,
    StatusResponse,
    StopTurnResponse,
    UpdateConversationRequest,
    UploadFileResponse,
    WorkspaceBindingResponse,
    WorkspaceEditDoc,
    WorkspaceFileEntry,
    WorkspaceFileListResponse,
    WorkspaceWriteRequest,
    WorkspaceWriteResult,
    interaction_result_from_body,
)
from agentcore.api.sse import sse_attach_response, sse_response
from agentcore.config import settings
from agentcore.conversation.quota import QuotaLimits, enforce_quota
from agentcore.conversation.rate_limit import enforce_user_message_rate_limit
from agentcore.conversation.service import (
    dispatch_handoff,
    record_local_turn,
    regenerate_chat,
    resume_chat,
    stream_chat,
)
from agentcore.core.errors import (
    BYOKKeyMissingError,
    ConflictError,
    NotFoundError,
    ValidationError,
)
from agentcore.core.logging import get_logger
from agentcore.db.models import Conversation, User
from agentcore.db.repositories import (
    ConversationRepository,
    CostEventRepository,
    FolderRepository,
    HandoffJobRepository,
    MessageRepository,
    ModelModeRepository,
    TurnJournalRepository,
)
from agentcore.llm.byok import LLMCredentials, resolve_user_llm_credentials
from agentcore.runtime.checkpoints import CheckpointResponse
from agentcore.runtime.events import (
    EventSink,
    error_event,
    handoff_apply_done,
    handoff_snapshot_done,
)
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.journal import runs_from_entries
from agentcore.runtime.suspension_persistence import (
    claim_paused_turn,
    list_paused_turns,
)
from agentcore.runtime.turn_runs import turn_runs
from agentcore.storage import SnapshotNotFound
from agentcore.workspace.files import (
    create_dir,
    delete_file,
    download_file,
    list_files,
    move_file,
    read_file_for_edit,
    upload_file,
    write_file_text,
)
from agentcore.workspace.git import CloneError, clone_repo
from agentcore.workspace.handoff import snapshot_local
from agentcore.workspace.handoff_apply import ApplySelection, apply_handoff
from agentcore.workspace.handoff_diff import compute_handoff_diff
from agentcore.workspace.locate import (
    LocalBinding,
    build_workspace,
    default_workspace_name,
    resolve_local_binding,
    workspace_storage_key,
)
from agentcore.workspace.locks import workspace_lock
from agentcore.workspace.protocol import (
    AlreadyExists,
    NotAFile,
    NotUTF8,
    OutsideWorkspace,
    PathNotFound,
)
from agentcore.workspace.snapshots import (
    create_snapshot,
    list_snapshots,
    read_snapshot,
    restore_snapshot,
)

router = APIRouter(prefix="/conversations", tags=["conversations"])

logger = get_logger(__name__)


async def _require_owned_conversation(
    conversation_id: str, user_id: str, repo: ConversationRepository
) -> None:
    """404 unless the conversation exists and belongs to the user."""
    conv = await repo.get_by_id(conversation_id, user_id=user_id)
    if not conv:
        raise NotFoundError("对话不存在")


def _summary_with_count(
    conv: Conversation, counts: dict[str, int]
) -> ConversationSummary:
    """Build a conversation summary, filling ``message_count`` from a counts map.

    The list/grouped endpoints precompute counts in one query (see
    ``MessageRepository.counts_for_conversations``) and pass the map here so the
    sidebar gets each chat's count without an N+1; absent ids default to 0.
    """
    summary = ConversationSummary.model_validate(conv)
    summary.message_count = counts.get(conv.id, 0)
    return summary


async def _get_owned_conversation(
    conversation_id: str, user_id: str, repo: ConversationRepository
) -> Conversation:
    """Return the conversation (for its ``folder_id``) or 404 if not owned.

    Snapshot routes need ``folder_id`` to resolve the right workspace: a folder's
    conversations share its space; an ungrouped one has its own (workspace.locate).
    """
    conv = await repo.get_by_id(conversation_id, user_id=user_id)
    if not conv:
        raise NotFoundError("对话不存在")
    return conv


def _binding_response(
    conv: Conversation, folder: object | None
) -> WorkspaceBindingResponse:
    """Render a conversation's resolved workspace mode (§七) as the API response.

    文件夹即工作区: a binding lives on the folder (shared by its siblings), so a filed
    conversation reports ``scope="folder"`` — unbinding affects every chat in it. A
    裸聊 has no folder/workspace, so it is always cloud and reports
    ``scope="conversation"`` (only itself).
    """
    scope = "folder" if conv.folder_id else "conversation"
    binding = resolve_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=getattr(folder, "local_root_id", None),
    )
    if binding is None:
        return WorkspaceBindingResponse(mode="cloud", scope=scope, root_id=None)
    return WorkspaceBindingResponse(mode="local", scope=scope, root_id=binding.root_id)


@router.post("", response_model=ConversationSummary, status_code=201)
async def create_conversation(
    body: CreateConversationRequest,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
    mode_repo: ModelModeRepository = Depends(get_model_mode_repo),
):
    # A non-null target folder must be one of the user's own live folders (else
    # 404), mirroring the move endpoint so a chat can never be born in someone
    # else's or a deleted folder.
    if body.folder_id is not None:
        folder = await folder_repo.get_by_id(body.folder_id, user_id=user.user_id)
        if not folder:
            raise NotFoundError("文件夹不存在")
    # An explicit initial 质量档 must be a known preset or one of the user's own
    # custom modes (else 400); None inherits the default.
    await validate_mode_ref(body.model_mode, user_id=user.user_id, repo=mode_repo)
    conv = await repo.create(
        user_id=user.user_id,
        title=body.title,
        folder_id=body.folder_id,
        model_mode=body.model_mode,
    )
    return ConversationSummary.model_validate(conv)


@router.get("", response_model=ConversationListResponse)
async def list_conversations(
    user: AuthUser,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    archived: bool = Query(
        False, description="True 返回已归档对话（「已归档」视图）；默认仅返回未归档"
    ),
    repo: ConversationRepository = Depends(get_conversation_repo),
    msg_repo: MessageRepository = Depends(get_message_repo),
):
    offset = (page - 1) * page_size
    conversations, total = await repo.list_by_user(
        user.user_id, limit=page_size, offset=offset, archived=archived
    )
    counts = await msg_repo.counts_for_conversations([c.id for c in conversations])
    return ConversationListResponse(
        data=[_summary_with_count(c, counts) for c in conversations],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/grouped", response_model=GroupedConversationsResponse)
async def list_conversations_grouped(
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
    msg_repo: MessageRepository = Depends(get_message_repo),
):
    """Folders + their conversations + the ungrouped remainder (sidebar).

    Declared before ``/{conversation_id}`` so "grouped" isn't captured as an id.
    A conversation whose folder is missing/deleted falls back to ungrouped.
    """
    folders = await folder_repo.list_by_user(user.user_id)
    conversations = await conv_repo.list_all_by_user(user.user_id)
    counts = await msg_repo.counts_for_conversations([c.id for c in conversations])

    buckets: dict[str, list[ConversationSummary]] = {f.id: [] for f in folders}
    ungrouped: list[ConversationSummary] = []
    for conv in conversations:
        summary = _summary_with_count(conv, counts)
        if conv.folder_id in buckets:
            buckets[conv.folder_id].append(summary)
        else:
            ungrouped.append(summary)

    return GroupedConversationsResponse(
        folders=[
            FolderGroup(
                id=f.id,
                name=f.name,
                local_dir=f.local_dir,
                local_root_id=f.local_root_id,
                conversations=buckets[f.id],
            )
            for f in folders
        ],
        ungrouped=ungrouped,
    )


@router.get("/{conversation_id}", response_model=ConversationSummary)
async def get_conversation(
    conversation_id: str,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    conv = await repo.get_by_id(conversation_id, user_id=user.user_id)
    if not conv:
        raise NotFoundError("对话不存在")
    return ConversationSummary.model_validate(conv)


@router.patch("/{conversation_id}", response_model=ConversationSummary)
async def update_conversation(
    conversation_id: str,
    body: UpdateConversationRequest,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
    mode_repo: ModelModeRepository = Depends(get_model_mode_repo),
):
    # Patch only the fields the client sent: an omitted ``model_mode`` is left
    # untouched, while an explicit null clears it back to「inherit default」.
    fields = body.model_fields_set
    conv = await repo.get_by_id(conversation_id, user_id=user.user_id)
    if not conv:
        raise NotFoundError("对话不存在")
    if "title" in fields and body.title is not None:
        conv = await repo.update_title(conversation_id, body.title, user_id=user.user_id)
    if "model_mode" in fields:
        await validate_mode_ref(body.model_mode, user_id=user.user_id, repo=mode_repo)
        conv = await repo.set_model_mode(
            conversation_id, body.model_mode, user_id=user.user_id
        )
    # Sidebar housekeeping toggles (对话基础功能补齐): pin floats the row to the top,
    # archive hides it from the live list (both reversible, no tri-state → a null is
    # ignored as「unchanged」).
    if "pinned" in fields and body.pinned is not None:
        conv = await repo.set_pinned(conversation_id, body.pinned, user_id=user.user_id)
    if "archived" in fields and body.archived is not None:
        conv = await repo.set_archived(
            conversation_id, body.archived, user_id=user.user_id
        )
    return ConversationSummary.model_validate(conv)


@router.patch("/{conversation_id}/folder", response_model=ConversationSummary)
async def move_conversation_to_folder(
    conversation_id: str,
    body: MoveConversationRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
    msg_repo: MessageRepository = Depends(get_message_repo),
):
    """Move a conversation into a folder, or out of one (``folder_id=null``).

    A non-null target must be one of the user's own live folders (else 404), so
    a chat can never be filed into someone else's or a deleted folder.

    A conversation's workspace is fixed once it starts (双模式工作区 §九 ⑩): its
    folder decides which workspace directory it runs in — and whether cloud or
    local — so moving a *started* chat across folders would silently re-point it at
    a different directory and orphan its accumulated files. Such a move is refused
    with 409; only an unsent (zero-message) chat is freely fileable. A no-op move
    (already in the target) never changes the workspace, so it is always allowed.
    """
    conv = await conv_repo.get_by_id(conversation_id, user_id=user.user_id)
    if not conv:
        raise NotFoundError("对话不存在")
    if conv.folder_id != body.folder_id:
        if body.folder_id is not None:
            folder = await folder_repo.get_by_id(body.folder_id, user_id=user.user_id)
            if not folder:
                raise NotFoundError("文件夹不存在")
        if await msg_repo.count_by_conversation(conversation_id) > 0:
            raise ConflictError("对话开始后不可更换工作区")
        conv = await conv_repo.set_folder(
            conversation_id, body.folder_id, user_id=user.user_id
        )
        if not conv:
            raise NotFoundError("对话不存在")
    return ConversationSummary.model_validate(conv)


@router.delete("/{conversation_id}", response_model=StatusResponse)
async def delete_conversation(
    conversation_id: str,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    deleted = await repo.soft_delete(conversation_id, user_id=user.user_id)
    if not deleted:
        raise NotFoundError("对话不存在")
    return StatusResponse()


@router.get("/{conversation_id}/messages", response_model=MessageListResponse)
async def list_messages(
    conversation_id: str,
    user: AuthUser,
    limit: int = Query(100, ge=1, le=200),
    before: datetime | None = Query(None),
    after: datetime | None = Query(None),
    around: str | None = Query(None),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    repo: MessageRepository = Depends(get_message_repo),
    journal_repo: TurnJournalRepository = Depends(get_turn_journal_repo),
):
    """A window of a conversation's messages (cursor-windowed, chronological).

    Four mutually-exclusive modes (checked in this order):

    - ``around={message_id}``: a window centered on a message — the search-hit jump
      (load-around B). 404 if the message isn't in this conversation.
    - ``before={iso}``: the page strictly older than the cursor (scroll up).
    - ``after={iso}``: the page strictly newer than the cursor (scroll down).
    - none: the latest window (conversation open).

    ``has_more_before`` / ``has_more_after`` drive infinite scroll; a one-sided
    query computes only the flag for the direction it moves in (an ``around`` window
    computes both). ``total`` is the conversation's full message count.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    total = await repo.count_by_conversation(conversation_id)

    has_more_before = False
    has_more_after = False
    if around is not None:
        window = await repo.window_around(
            conversation_id, message_id=around, before=limit, after=limit
        )
        if window is None:
            raise NotFoundError("消息不存在")
        messages, has_more_before, has_more_after = window
    elif before is not None:
        messages, has_more_before = await repo.list_before(
            conversation_id, before=before, limit=limit
        )
    elif after is not None:
        messages, has_more_after = await repo.list_after(
            conversation_id, after=after, limit=limit
        )
    else:
        messages, has_more_before = await repo.list_latest(
            conversation_id, limit=limit
        )

    # Project each assistant message's replay payload (runs) from the唯一事实源
    # turn_journal (§18.3) — it is no longer stored on the message row. One batched
    # query over the page's message ids (no N+1); turns with no facts stay runs=None.
    journal_map = await journal_repo.load_map([m.id for m in messages])
    details: list[MessageDetail] = []
    for m in messages:
        detail = MessageDetail.model_validate(m)
        runs = runs_from_entries(journal_map.get(m.id))
        if runs is not None:
            detail.runs = RunsPayload.model_validate(runs)
        details.append(detail)

    return MessageListResponse(
        data=details,
        total=total,
        has_more_before=has_more_before,
        has_more_after=has_more_after,
    )


@router.delete("/{conversation_id}/messages/{message_id}", response_model=StatusResponse)
async def delete_message(
    conversation_id: str,
    message_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    repo: MessageRepository = Depends(get_message_repo),
):
    """Delete a single message (单条消息删除).

    Owner-scoped: proving ownership of the conversation first, then deleting only
    within it, means a guessed ``message_id`` from another user's chat can't be
    removed (404 on a foreign/absent conversation; no-op-then-404 on an absent
    message). Append-only ``cost_events`` are intentionally preserved — deleting a
    message never rewrites real spend (不变量 #1).
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    deleted = await repo.delete_by_id(message_id, conversation_id=conversation_id)
    if not deleted:
        raise NotFoundError("消息不存在")
    return StatusResponse()


async def _preflight_turn_llm(
    *,
    session: AsyncSession,
    user: User,
    cost_repo: CostEventRepository,
) -> LLMCredentials | None:
    """Pre-turn billing gate, run before the SSE opens so a refused turn gets a
    clean error instead of a half-opened stream.

    BYOK mode (config.billing_mode): require the user's own DeepSeek key and return
    the resolved credentials to thread through the turn — refuse with
    ``BYOKKeyMissingError`` (→ 402 LLM_KEY_REQUIRED) when none is configured, so the
    client routes the user to 设置·模型配置. Platform mode: keep the quota 防线 and
    return ``None`` (the turn runs on the global server key). Resolving here and
    threading the result down means "preflight passes" == "the turn runs on this
    key" — the runtime never re-resolves to a different decision.
    """
    if settings.billing_mode == "byok":
        credentials = await resolve_user_llm_credentials(session, user.user_id)
        if credentials is None:
            raise BYOKKeyMissingError(
                "请先在「设置 · 模型配置」中填入你的 DeepSeek API Key，再发起对话。"
            )
        return credentials
    await enforce_quota(cost_repo, user.user_id, limits=QuotaLimits.for_user(user))
    return None


@router.post("/{conversation_id}/messages")
async def send_message(
    conversation_id: str,
    body: SendMessageRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
):
    """Send a user message and get a streaming AI response via SSE.

    执行与请求解耦 (C1 · slice 1a): the pipeline runs as a *detached* task tracked in
    the ``TurnRunRegistry`` (keyed by conversation), and the SSE stream only attaches
    to it (``detach_on_disconnect=True``). A client disconnect therefore no longer
    kills the turn (案例 1: 7-min 断连即丢交付) — it finishes + persists in the
    background; an explicit 停止 routes through ``POST .../stop`` instead.

    Gated before the stream starts (成本配额与计费.md §一) so a refused turn gets a
    clean error instead of a half-opened SSE: per-user rate limit first (sheds a
    flooding account before any resource DB work), then ownership, then the
    BYOK/quota billing gate (BYOK mode requires the user's own key; platform mode
    enforces quota). The resolved BYOK credentials thread through the whole turn.
    """
    await enforce_user_message_rate_limit(user.user_id)
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    credentials = await _preflight_turn_llm(
        session=session, user=user, cost_repo=cost_repo
    )

    sink = EventSink()

    task = asyncio.create_task(
        stream_chat(
            conversation_id=conversation_id,
            user_message=body.content,
            user_id=user.user_id,
            sink=sink,
            attachments=[a.model_dump() for a in body.attachments],
            llm_credentials=credentials,
            local_container_root_id=body.local_container_root_id,
        )
    )
    turn_runs.register(conversation_id=conversation_id, task=task, sink=sink)

    return sse_response(sink, detach_on_disconnect=True)


@router.post("/{conversation_id}/stop", response_model=StopTurnResponse)
async def stop_message(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Explicitly stop the conversation's in-flight turn (执行与请求解耦 C1 · slice 1a).

    Now that a client disconnect no longer cancels a turn (it runs to completion +
    persists in the background), the user's 「停止」 routes here instead. Cancels the
    detached run task tracked in the ``TurnRunRegistry``, which unwinds through the
    turn's ``CancelledError`` salvage — finished team work is kept as an incomplete
    message (断线别白干). Idempotent: ``stopped=false`` when nothing is running
    (already finished / never started), so a late click settles cleanly. Owner-gated.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    stopped = turn_runs.stop(conversation_id)
    return StopTurnResponse(stopped=stopped)


@router.get("/{conversation_id}/stream")
async def attach_stream(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Re-attach to the conversation's in-flight turn and 续看 it live (C1 · slice 1b).

    Since a disconnect no longer cancels a turn (slice 1a — it runs detached + persists
    in the background), a client that dropped (network blip) or reopened the app can
    rejoin the live run here: the SSE replays the transcript so far (coalesced — one
    content / reasoning block, the team graph, finished tool calls) then tails new
    events, all in the SAME event shape as the original stream, so the client folds it
    through one dispatch path.

    Returns ``204 No Content`` when no run is live for the conversation (already
    finished / never started / suspended at a checkpoint) — the client then falls back
    to the persisted transcript (reload) / durable resume. A pure observer: dropping
    this stream detaches again (never cancels); an explicit 停止 still goes through
    ``POST .../stop``. Owner-gated.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    run = turn_runs.get(conversation_id)
    if run is None or run.task.done():
        return Response(status_code=204)
    return sse_attach_response(run.sink)


@router.post("/{conversation_id}/local-turns", response_model=RecordTurnResponse)
async def record_local_turn_endpoint(
    conversation_id: str,
    body: RecordTurnRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Persist a turn that ran on the user's machine via the sidecar (双模式工作区 §一.1).

    The local engine produced the reply on the user's box (no server SSE turn ran),
    so the desktop reports the finished turn here to land it in durable history.
    Owner-scoped (404 for a non-owner). Spend is NOT recorded here — a sidecar turn's
    LLM calls are metered authoritatively at the cloud inference proxy (``/v1/inference``,
    Slice 4a); this endpoint persists content only.

    Unlike ``send_message`` there is NO pre-turn billing gate — the turn already
    happened on the user's machine; this only RECORDS its content. The write-back is
    idempotent so the desktop can safely retry a flaky POST: messages dedupe on the
    client-minted ``user_message_id``, so a retry after a committed-but-lost response
    never duplicates the turn. The title is generated best-effort on the user's resolved
    BYOK key (None → platform fallback).
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    # Best-effort credentials for the title pass — unlike send_message's preflight we
    # never REFUSE here (the turn is already done; recording must not be blockable).
    credentials = await resolve_user_llm_credentials(session, user.user_id)
    result = await record_local_turn(
        conversation_id=conversation_id,
        user_id=user.user_id,
        user_message=body.user_message,
        assistant_content=body.content,
        assistant_reasoning=body.reasoning_content,
        citations=[c.model_dump() for c in body.citations] or None,
        runs=body.runs.model_dump() if body.runs else None,
        user_message_id=body.user_message_id,
        message_id=body.message_id,
        input_tokens=body.input_tokens,
        output_tokens=body.output_tokens,
        rounds=body.rounds,
        llm_credentials=credentials,
    )
    return RecordTurnResponse(**result)


@router.post(
    "/{conversation_id}/interactions/{interaction_id}", response_model=StatusResponse
)
async def resolve_interaction(
    conversation_id: str,
    interaction_id: str,
    user: AuthUser,
    body: ResolveInteractionRequest = Body(discriminator="kind"),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Settle any paused interaction over the unified bridge (§18.2).

    One endpoint for every suspend kind, discriminated on ``body.kind``:

    - ``approval`` — authorize / deny a paused GRANTABLE tool call (the gate
      auto-denies anything left unanswered);
    - ``ask_user`` — the user's checkpoint answer (continue / adjust / stop);
    - ``client_tool`` — a bound desktop's result envelope for a local-workspace op.

    The pending interaction (awaiting in the live ``send_message`` SSE turn) resumes
    with its kind-specific result. 404 if it is unknown, already settled, timed out,
    belongs to another conversation, or its kind does not match — a stale resolve
    falls through as "not found".
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)

    # Per-kind result construction is shared with the sidecar's ``respond`` so cloud
    # and local settle an interaction identically (see ``interaction_result_from_body``).
    result = interaction_result_from_body(body)

    registry = default_interaction_registry()
    pending = registry.get(interaction_id)
    if (
        pending is None
        or pending.conversation_id != conversation_id
        or pending.kind != body.kind
    ):
        raise NotFoundError("交互请求不存在或已处理")
    if not registry.resolve(
        interaction_id, result, conversation_id=conversation_id
    ):
        raise NotFoundError("交互请求不存在或已处理")
    return StatusResponse()


# --- Local-mode binding (双模式工作区 §七: 模式跟着文件在哪自动走) ---


@router.get(
    "/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse
)
async def get_workspace_binding(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Report a conversation's resolved workspace mode (local vs cloud).

    Backs the desktop's mode badge: cloud by default, local once its governing
    scope (folder when filed, else the conversation) is bound to a desktop root.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    folder = (
        await folder_repo.get_by_id(conv.folder_id, user_id=user.user_id)
        if conv.folder_id
        else None
    )
    return _binding_response(conv, folder)


@router.put(
    "/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse
)
async def bind_workspace(
    conversation_id: str,
    body: BindLocalWorkspaceRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Bind the conversation's workspace to a desktop FS root (switch to local).

    文件夹即工作区: a binding lives on the folder (= 工作区), shared by its siblings.
    A 裸聊 has no folder yet, so "打开本地文件夹" lazily mints one (named after the
    chat) and files the conversation into it before binding — the explicit-promote
    counterpart to writing a file (§懒建). Idempotent — re-binding overwrites the
    stored root id.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if not conv.folder_id:
        folder = await folder_repo.create(
            user_id=user.user_id,
            name=default_workspace_name(conv.title),
            local_root_id=body.root_id,
        )
        await conv_repo.set_folder(conversation_id, folder.id, user_id=user.user_id)
        return WorkspaceBindingResponse(
            mode="local", scope="folder", root_id=body.root_id
        )
    folder = await folder_repo.set_local_root_id(
        conv.folder_id, body.root_id, user_id=user.user_id
    )
    if not folder:
        raise NotFoundError("文件夹不存在")
    return WorkspaceBindingResponse(mode="local", scope="folder", root_id=body.root_id)


@router.delete(
    "/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse
)
async def unbind_workspace(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Unbind the conversation's workspace (fall back to cloud).

    Clears the binding on the folder (= 工作区), returning every conversation in it
    to cloud — which the ``folder`` scope in the response signals. A 裸聊 has no
    workspace to unbind, so it is already cloud (a no-op).
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if not conv.folder_id:
        return WorkspaceBindingResponse(
            mode="cloud", scope="conversation", root_id=None
        )
    folder = await folder_repo.set_local_root_id(
        conv.folder_id, None, user_id=user.user_id
    )
    if not folder:
        raise NotFoundError("文件夹不存在")
    return WorkspaceBindingResponse(mode="cloud", scope="folder", root_id=None)


async def _run_handoff(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    binding: LocalBinding,
    sink: EventSink,
) -> None:
    """Drive a local→云 handoff snapshot to completion over its SSE sink (P2e / e1).

    Mirrors ``stream_chat``'s shape: the ARCHIVE op is emitted on ``sink`` (the
    bound desktop fulfils it via the ops resolve endpoint), and on success a
    ``handoff_snapshot_done`` carrying the new snapshot id is emitted before the
    stream closes. Any failure is surfaced as an inline ``error`` event (never an
    unhandled crash on this detached task), so the client always learns the outcome.
    """
    try:
        ref = await snapshot_local(
            user_id=user_id,
            folder_id=folder_id,
            conversation_id=conversation_id,
            binding=binding,
            sink=sink,
        )
        sink.emit(
            handoff_snapshot_done(
                snapshot_id=ref.snapshot_id,
                conversation_id=conversation_id,
                size_bytes=ref.size_bytes,
            )
        )
    except Exception as e:
        logger.warning("handoff.failed", conversation_id=conversation_id, error=str(e))
        sink.emit(error_event("HANDOFF_FAILED", str(e)))
    finally:
        if not sink._closed:
            sink.close()


@router.post("/{conversation_id}/workspace/handoff")
async def handoff_local_workspace(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Snapshot a local-mode workspace to the cloud over the channel (双模式工作区 P2e / e1).

    Local-mode files live on the user's machine, so the post-turn OSS backup skips
    them; this is the explicit, on-demand 本地→云 snapshot (§四). Streams SSE: a
    ``workspace_op_required`` (the ARCHIVE op) the bound desktop fulfils, then a
    ``handoff_snapshot_done`` carrying the new snapshot id (it lands in the same
    snapshot list / restore / download as cloud-mode versions). 422 when the
    conversation is not in local mode — a cloud workspace already snapshots itself,
    and there is nothing on the user's disk to fetch.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    folder = (
        await folder_repo.get_by_id(conv.folder_id, user_id=user.user_id)
        if conv.folder_id
        else None
    )
    binding = resolve_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=folder.local_root_id if folder else None,
        label=folder.name if folder else None,
    )
    if binding is None:
        raise ValidationError("该对话不是本地模式")

    sink = EventSink()
    task = asyncio.create_task(
        _run_handoff(
            user_id=user.user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            binding=binding,
            sink=sink,
        )
    )
    return sse_response(sink, producer=task)


@router.post("/{conversation_id}/workspace/handoff/dispatch")
async def dispatch_handoff_job(
    conversation_id: str,
    body: DispatchHandoffRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Hand a task off to a cloud team seeded from the local workspace (P2e / e2).

    The 本地→云 交接 (§四): snapshot the user's local files, then run an Agent team on
    that snapshot in the cloud — autonomously, in the background — so a parallel team
    is not bottlenecked by the single desktop channel. Streams SSE: a
    ``workspace_op_required`` (the ARCHIVE op) the bound desktop fulfils, then a
    ``handoff_job_started`` carrying the job id; the cloud run continues detached
    after the stream closes (poll ``GET …/handoff/jobs`` for its status). 422 when
    the conversation is not in local mode (nothing local to hand off).

    Gated like ``send_message`` (it spends tokens): rate limit → ownership → quota.
    """
    await enforce_user_message_rate_limit(user.user_id)
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    await enforce_quota(cost_repo, user.user_id, limits=QuotaLimits.for_user(user))

    folder = (
        await folder_repo.get_by_id(conv.folder_id, user_id=user.user_id)
        if conv.folder_id
        else None
    )
    binding = resolve_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=folder.local_root_id if folder else None,
        label=folder.name if folder else None,
    )
    if binding is None:
        raise ValidationError("该对话不是本地模式")

    sink = EventSink()
    task = asyncio.create_task(
        dispatch_handoff(
            conversation_id=conversation_id,
            user_id=user.user_id,
            folder_id=conv.folder_id,
            binding=binding,
            task=body.task,
            sink=sink,
        )
    )
    return sse_response(sink, producer=task)


@router.get("/{conversation_id}/handoff/jobs", response_model=HandoffJobListResponse)
async def list_handoff_jobs(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    job_repo: HandoffJobRepository = Depends(get_handoff_job_repo),
):
    """A conversation's local→云 handoff jobs, newest first (双模式工作区 P2e / e2).

    Backs the client's job badge / PR list: poll this to learn when a dispatched
    cloud run finishes (status succeeded / failed). 404 if the conversation is not
    owned.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    jobs = await job_repo.list_for_source(conversation_id, user_id=user.user_id)
    data = [HandoffJobSummary.model_validate(j) for j in jobs]
    return HandoffJobListResponse(data=data, total=len(data))


@router.get(
    "/{conversation_id}/handoff/jobs/{job_id}", response_model=HandoffJobSummary
)
async def get_handoff_job(
    conversation_id: str,
    job_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    job_repo: HandoffJobRepository = Depends(get_handoff_job_repo),
):
    """One handoff job's status + result snapshots (双模式工作区 P2e / e2).

    404 if the conversation is not owned, or the job is unknown / belongs to a
    different source conversation.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    job = await job_repo.get_by_id(job_id, user_id=user.user_id)
    if job is None or job.source_conversation_id != conversation_id:
        raise NotFoundError("交接任务不存在")
    return HandoffJobSummary.model_validate(job)


@router.get(
    "/{conversation_id}/handoff/jobs/{job_id}/diff",
    response_model=HandoffDiffResponse,
)
async def get_handoff_job_diff(
    conversation_id: str,
    job_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    job_repo: HandoffJobRepository = Depends(get_handoff_job_repo),
):
    """A finished handoff's result diff — the change set for the local apply (P2e / e3).

    Compares the team's result snapshot against the base it ran on and returns the
    per-file change set (added / modified / deleted) the desktop replays onto the
    user's local files; each entry carries the base hash for the client's three-way
    conflict check (clean / already-applied / conflict). 404 if the conversation is
    not owned or the job is unknown / from another source conversation; 409 while the
    job has not succeeded yet (no result to diff).
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    job = await job_repo.get_by_id(job_id, user_id=user.user_id)
    if job is None or job.source_conversation_id != conversation_id:
        raise NotFoundError("交接任务不存在")
    if job.status != "succeeded" or not job.result_snapshot_id:
        raise ConflictError("交接任务尚未产出结果")
    try:
        changes = await compute_handoff_diff(
            user_id=user.user_id,
            source_folder_id=conv.folder_id,
            source_conversation_id=conversation_id,
            base_snapshot_id=job.base_snapshot_id,
            job_conversation_id=job.job_conversation_id,
            result_snapshot_id=job.result_snapshot_id,
        )
    except SnapshotNotFound as e:
        raise NotFoundError("交接快照不存在") from e
    data = [HandoffFileChange.model_validate(c) for c in changes]
    return HandoffDiffResponse(
        job_id=job.id,
        data=data,
        total=len(data),
        added=sum(1 for c in data if c.change_type == "added"),
        modified=sum(1 for c in data if c.change_type == "modified"),
        deleted=sum(1 for c in data if c.change_type == "deleted"),
    )


async def _run_apply(
    *,
    user_id: str,
    source_folder_id: str | None,
    source_conversation_id: str,
    job_id: str,
    job_conversation_id: str,
    base_snapshot_id: str,
    result_snapshot_id: str,
    binding: LocalBinding,
    selections: list[ApplySelection],
    sink: EventSink,
) -> None:
    """Drive a handoff result apply to completion over its SSE sink (P2e / e3).

    Builds the desktop-backed ``LocalWorkspace`` over this stream, then replays the
    accepted changes onto the user's machine (WRITE_BYTES / DELETE the bound desktop
    fulfils). On success a ``handoff_apply_done`` carrying the per-file outcomes is
    emitted before the stream closes; a missing snapshot or any failure surfaces as
    an inline ``error`` event (never an unhandled crash on this detached task).
    """
    try:
        backend = build_workspace(
            user_id=user_id,
            folder_id=source_folder_id,
            conversation_id=source_conversation_id,
            sink=sink,
            local_binding=binding,
        )
        outcomes = await apply_handoff(
            backend=backend,
            user_id=user_id,
            source_folder_id=source_folder_id,
            source_conversation_id=source_conversation_id,
            base_snapshot_id=base_snapshot_id,
            job_conversation_id=job_conversation_id,
            result_snapshot_id=result_snapshot_id,
            selections=selections,
        )
        sink.emit(
            handoff_apply_done(
                job_id=job_id,
                conversation_id=source_conversation_id,
                results=[o.to_dict() for o in outcomes],
            )
        )
    except SnapshotNotFound as e:
        logger.warning(
            "handoff.apply_snapshot_missing",
            conversation_id=source_conversation_id,
            error=str(e),
        )
        sink.emit(error_event("HANDOFF_SNAPSHOT_NOT_FOUND", str(e)))
    except Exception as e:
        logger.warning(
            "handoff.apply_failed",
            conversation_id=source_conversation_id,
            error=str(e),
        )
        sink.emit(error_event("HANDOFF_APPLY_FAILED", str(e)))
    finally:
        if not sink._closed:
            sink.close()


@router.post("/{conversation_id}/handoff/jobs/{job_id}/apply")
async def apply_handoff_job(
    conversation_id: str,
    job_id: str,
    body: ApplyHandoffRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    job_repo: HandoffJobRepository = Depends(get_handoff_job_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Apply a finished handoff's selected changes back to the local workspace (P2e / e3).

    The last leg of the 本地→云 round trip: the user's per-file decisions (take cloud /
    keep local, with the locally-observed hash) are replayed onto their machine over
    the channel. Streams SSE: ``workspace_op_required`` (WRITE_BYTES / DELETE) the
    bound desktop fulfils, then a ``handoff_apply_done`` with the per-file outcomes.
    The conflict gate is server-authoritative — a file that diverged locally since the
    base is refused (status ``conflict``) unless its selection ``force``\\s it.

    404 if the conversation is not owned or the job is unknown / from another source;
    409 while the job has not succeeded yet; 422 when the conversation is not in local
    mode (nothing local to apply onto).
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    job = await job_repo.get_by_id(job_id, user_id=user.user_id)
    if job is None or job.source_conversation_id != conversation_id:
        raise NotFoundError("交接任务不存在")
    if job.status != "succeeded" or not job.result_snapshot_id:
        raise ConflictError("交接任务尚未产出结果")

    folder = (
        await folder_repo.get_by_id(conv.folder_id, user_id=user.user_id)
        if conv.folder_id
        else None
    )
    binding = resolve_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=folder.local_root_id if folder else None,
        label=folder.name if folder else None,
    )
    if binding is None:
        raise ValidationError("该对话不是本地模式")

    selections = [
        ApplySelection(
            path=s.path, decision=s.decision, local_sha=s.local_sha, force=s.force
        )
        for s in body.selections
    ]
    sink = EventSink()
    task = asyncio.create_task(
        _run_apply(
            user_id=user.user_id,
            source_folder_id=conv.folder_id,
            source_conversation_id=conversation_id,
            job_id=job.id,
            job_conversation_id=job.job_conversation_id,
            base_snapshot_id=job.base_snapshot_id,
            result_snapshot_id=job.result_snapshot_id,
            binding=binding,
            selections=selections,
            sink=sink,
        )
    )
    return sse_response(sink, producer=task)


@router.post("/{conversation_id}/messages/{message_id}/regenerate")
async def regenerate_message(
    conversation_id: str,
    message_id: str,
    body: RegenerateMessageRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
):
    """Re-run a turn from an existing user message via SSE.

    Serves both "regenerate" (no body content — reuse the stored user text) and
    "edit & resend" (``content`` set — edit the user message first). The target
    ``message_id`` must be a user message; the superseded assistant reply and any
    later turns are dropped before re-running. Like ``send_message``, the pipeline
    runs as a detached task tracked in the ``TurnRunRegistry`` and the SSE only
    attaches (执行与请求解耦 C1 · slice 1a): a disconnect lets it finish + persist,
    an explicit 停止 goes through ``POST .../stop``. A re-run is a fresh turn, so it
    passes the same gates (rate limit → ownership → BYOK/quota billing gate) as
    ``send_message``.
    """
    await enforce_user_message_rate_limit(user.user_id)
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    credentials = await _preflight_turn_llm(
        session=session, user=user, cost_repo=cost_repo
    )

    sink = EventSink()

    task = asyncio.create_task(
        regenerate_chat(
            conversation_id=conversation_id,
            message_id=message_id,
            user_id=user.user_id,
            sink=sink,
            edited_content=body.content,
            llm_credentials=credentials,
        )
    )
    turn_runs.register(conversation_id=conversation_id, task=task, sink=sink)

    return sse_response(sink, detach_on_disconnect=True)


@router.get("/{conversation_id}/paused", response_model=PausedTurnListResponse)
async def list_conversation_paused_turns(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """List turns awaiting resume after a durable plan_review / ask_user pause (结构化挂起 2b).

    Called on conversation reopen: a turn that paused then lost its live SSE
    (disconnect / restart) has no assistant message yet — only a persisted frame.
    The client renders each as a resume card by ``kind`` (plan_review from ``steps`` /
    ``pending``; ask_user from ``question`` + the optional ``assumptions`` /
    ``questions`` / ``style_options``) offering continue / adjust / stop → the resume
    endpoint. Oldest-first. 404 if not owned.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    frames = await list_paused_turns(conversation_id)
    data = [
        PausedTurnSummary(
            message_id=f.message_id,
            kind=f.kind,
            checkpoint_id=f.checkpoint_id,
            user_message=f.user_message,
            # plan_review fields (empty on an ask_user frame) ...
            steps=getattr(f, "steps", []),
            pending=getattr(f, "pending", []),
            # ... and ask_user fields (empty on a plan_review frame).
            question=getattr(f, "question", ""),
            context=getattr(f, "context", ""),
            assumptions=getattr(f, "assumptions", []),
            questions=getattr(f, "questions", []),
            style_options=getattr(f, "style_options", []),
        )
        for f in frames
    ]
    return PausedTurnListResponse(data=data, total=len(data))


@router.post("/{conversation_id}/messages/{message_id}/resume")
async def resume_message(
    conversation_id: str,
    message_id: str,
    body: ResumeTurnRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
):
    """Continue a durably-paused turn via SSE (结构化挂起 2b ``POST .../resume``).

    The turn paused at a plan_review / ask_user checkpoint and lost its live stream
    (disconnect / restart); only its persisted frame survived. Claims the frame
    (atomic read-and-delete, so a turn is never resumed twice — a second / stale call
    404s), then drives the rest of the turn on a fresh SSE just like a send.
    ``body.selected`` carries the user's ask_user picks (ignored for plan_review).
    Gated like ``send_message`` (it spends tokens): rate limit → ownership → BYOK/quota
    — all BEFORE the claim, so a refused turn keeps its resumable frame.
    """
    await enforce_user_message_rate_limit(user.user_id)
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    credentials = await _preflight_turn_llm(
        session=session, user=user, cost_repo=cost_repo
    )

    suspension = await claim_paused_turn(message_id, conversation_id=conversation_id)
    if suspension is None:
        raise NotFoundError("挂起的回合不存在或已处理")

    sink = EventSink()
    task = asyncio.create_task(
        resume_chat(
            suspension=suspension,
            response=CheckpointResponse(
                decision=body.decision, note=body.note, selected=body.selected
            ),
            sink=sink,
            llm_credentials=credentials,
        )
    )
    # 执行与请求解耦 (C1 · slice 1a): track the resumed run so a disconnect lets it
    # finish + persist and 停止 routes through POST .../stop, same as a fresh send.
    turn_runs.register(conversation_id=conversation_id, task=task, sink=sink)
    return sse_response(sink, detach_on_disconnect=True)


# --- Workspace snapshots (axis-3 persistence: backup / kept versions / download) ---


@router.get("/{conversation_id}/snapshots", response_model=SnapshotListResponse)
async def list_conversation_snapshots(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """List the conversation's workspace snapshots (newest first)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    refs = await list_snapshots(
        user_id=user.user_id,
        folder_id=conv.folder_id,
        conversation_id=conversation_id,
    )
    return SnapshotListResponse(
        data=[SnapshotSummary.model_validate(r) for r in refs],
        total=len(refs),
    )


@router.post(
    "/{conversation_id}/snapshots", response_model=SnapshotSummary, status_code=201
)
async def create_conversation_snapshot(
    conversation_id: str,
    body: CreateSnapshotRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Take a manual snapshot of the workspace (a ``label`` keeps it as a version)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=conv.folder_id, conversation_id=conversation_id
    )
    # Folder lock (决策④): serialize the manifest write against a running turn's
    # auto-snapshot and other same-workspace mutations.
    async with workspace_lock(key):
        ref = await create_snapshot(
            user_id=user.user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            label=body.label,
        )
    return SnapshotSummary.model_validate(ref)


@router.post(
    "/{conversation_id}/snapshots/{snapshot_id}/restore", response_model=StatusResponse
)
async def restore_conversation_snapshot(
    conversation_id: str,
    snapshot_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Restore the workspace to a snapshot (overwrites current files)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=conv.folder_id, conversation_id=conversation_id
    )
    # Folder lock (决策④): a restore rewrites the whole workspace, so it must not
    # interleave with a running turn or another mutation on the same space.
    try:
        async with workspace_lock(key):
            await restore_snapshot(
                user_id=user.user_id,
                folder_id=conv.folder_id,
                conversation_id=conversation_id,
                snapshot_id=snapshot_id,
            )
    except SnapshotNotFound as e:
        raise NotFoundError("快照不存在") from e
    return StatusResponse()


@router.get("/{conversation_id}/snapshots/{snapshot_id}/download")
async def download_conversation_snapshot(
    conversation_id: str,
    snapshot_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Download a snapshot archive (zip) of the workspace at that point in time."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    try:
        data = await read_snapshot(
            user_id=user.user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            snapshot_id=snapshot_id,
        )
    except SnapshotNotFound as e:
        raise NotFoundError("快照不存在") from e
    filename = f"workspace-{snapshot_id}.zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- Workspace files (bring files in / take results out: 文件进出·先上传) ---


async def _conv_write_folder(
    conv: Conversation,
    *,
    conv_repo: ConversationRepository,
    folder_repo: FolderRepository,
    user_id: str,
) -> str:
    """Folder id for a *write* to a conversation's workspace, promoting if 裸聊.

    文件夹即工作区: files live in a folder. A filed conversation writes to its folder;
    a 裸聊 (no folder) has no workspace, so a creating op lazily mints one named after
    the chat and files the conversation into it (§懒建) — the explicit-promote sibling
    of the team's first write. Returns the folder id addressing that workspace.
    """
    if conv.folder_id:
        return conv.folder_id
    folder = await folder_repo.create(
        user_id=user_id, name=default_workspace_name(conv.title)
    )
    await conv_repo.set_folder(conv.id, folder.id, user_id=user_id)
    return folder.id


@router.get("/{conversation_id}/workspace/files", response_model=WorkspaceFileListResponse)
async def list_workspace_files(
    conversation_id: str,
    user: AuthUser,
    recursive: bool = Query(False),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """List the files in the conversation's workspace (top level or recursive)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if conv.folder_id is None:
        # 裸聊 has no workspace until promoted into a folder (文件夹即工作区): nothing
        # to list, and a read must never materialize a phantom directory on disk.
        return WorkspaceFileListResponse(data=[], total=0)
    entries = await list_files(
        user_id=user.user_id,
        folder_id=conv.folder_id,
        conversation_id=conversation_id,
        recursive=recursive,
    )
    return WorkspaceFileListResponse(
        data=[WorkspaceFileEntry.model_validate(e) for e in entries],
        total=len(entries),
    )


@router.put(
    "/{conversation_id}/workspace/files/{path:path}", response_model=UploadFileResponse
)
async def upload_workspace_file(
    conversation_id: str,
    path: str,
    request: Request,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Upload (create/overwrite) a workspace file from the raw request body.

    The body is the file bytes (no multipart); ``path`` is the workspace-relative
    target. Bounded by ``workspace_upload_max_bytes`` so one request can't exhaust
    memory. A path that escapes the workspace is rejected (422). Uploading to a 裸聊
    promotes it into a folder workspace first (文件夹即工作区 §懒建).
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)

    max_bytes = settings.workspace_upload_max_bytes
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise ValidationError(f"文件超出 {max_bytes} 字节的上传上限")
    data = await request.body()
    if len(data) > max_bytes:
        raise ValidationError(f"文件超出 {max_bytes} 字节的上传上限")

    folder_id = await _conv_write_folder(
        conv, conv_repo=conv_repo, folder_repo=folder_repo, user_id=user.user_id
    )
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    try:
        # Folder lock (决策④): serialize the write against a running same-folder turn.
        async with workspace_lock(key):
            written = await upload_file(
                user_id=user.user_id,
                folder_id=folder_id,
                conversation_id=conversation_id,
                path=path,
                data=data,
            )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    return UploadFileResponse(path=path, size_bytes=written)


@router.get(
    "/{conversation_id}/workspace/edit/{path:path}",
    response_model=WorkspaceEditDoc,
)
async def read_workspace_file_for_edit(
    conversation_id: str,
    path: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Read a workspace file for in-panel editing (full text + mtime CAS baseline).

    Distinct from the raw-bytes download (preview, truncated): editing needs the whole
    file or a save would drop the tail. 裸聊 has no workspace yet, so 404.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if conv.folder_id is None:
        raise NotFoundError("文件不存在")
    try:
        text, mtime_ms, eol = await read_file_for_edit(
            user_id=user.user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            path=path,
        )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except (PathNotFound, NotAFile) as e:
        raise NotFoundError("文件不存在") from e
    except NotUTF8 as e:
        raise ValidationError("文件不是 UTF-8 文本，无法编辑") from e
    return WorkspaceEditDoc(text=text, mtime_ms=mtime_ms, eol=eol)


@router.put(
    "/{conversation_id}/workspace/edit/{path:path}",
    response_model=WorkspaceWriteResult,
)
async def write_workspace_file(
    conversation_id: str,
    path: str,
    body: WorkspaceWriteRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Conditionally write editor text back to a workspace file (mtime CAS).

    The write-time CAS (``baseline_mtime_ms``) makes a save that raced an Agent turn
    return ``conflict`` instead of clobbering it. Writing to a 裸聊 promotes it into a
    folder workspace first (文件夹即工作区 §懒建), like upload.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)

    max_bytes = settings.workspace_upload_max_bytes
    if len(body.content.encode("utf-8")) > max_bytes:
        raise ValidationError(f"文件超出 {max_bytes} 字节的上传上限")

    folder_id = await _conv_write_folder(
        conv, conv_repo=conv_repo, folder_repo=folder_repo, user_id=user.user_id
    )
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    try:
        # Folder lock (决策④): the CAS (mtime check + write) must be atomic against a
        # running same-folder turn, so an Agent write can't slip between check and write.
        async with workspace_lock(key):
            ok, mtime_ms = await write_file_text(
                user_id=user.user_id,
                folder_id=folder_id,
                conversation_id=conversation_id,
                path=path,
                content=body.content,
                baseline_mtime_ms=body.baseline_mtime_ms,
                eol=body.eol,
            )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except NotAFile as e:
        raise ValidationError("目标是目录，无法作为文件写入") from e
    return WorkspaceWriteResult(ok=ok, mtime_ms=mtime_ms, conflict=not ok)


@router.get("/{conversation_id}/workspace/files/{path:path}")
async def download_workspace_file(
    conversation_id: str,
    path: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Download a single file from the conversation's workspace."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if conv.folder_id is None:
        raise NotFoundError("文件不存在")  # 裸聊 has no workspace files yet.
    try:
        data = await download_file(
            user_id=user.user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            path=path,
        )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except (PathNotFound, NotAFile) as e:
        raise NotFoundError("文件不存在") from e

    filename = path.rsplit("/", 1)[-1] or "download"
    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return Response(
        content=data,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete(
    "/{conversation_id}/workspace/files/{path:path}", response_model=StatusResponse
)
async def delete_workspace_file(
    conversation_id: str,
    path: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Delete a file or directory from the conversation's workspace."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if conv.folder_id is None:
        raise NotFoundError("文件不存在")  # 裸聊 has no workspace files to delete.
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=conv.folder_id, conversation_id=conversation_id
    )
    try:
        # Folder lock (决策④): serialize the delete against a running same-folder turn.
        async with workspace_lock(key):
            await delete_file(
                user_id=user.user_id,
                folder_id=conv.folder_id,
                conversation_id=conversation_id,
                path=path,
            )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except PathNotFound as e:
        raise NotFoundError("文件不存在") from e
    return StatusResponse()


@router.post("/{conversation_id}/workspace/move", response_model=StatusResponse)
async def move_workspace_file(
    conversation_id: str,
    body: MoveFileRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Move/rename a file or directory within the conversation's workspace."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if conv.folder_id is None:
        raise NotFoundError("文件不存在")  # 裸聊 has no workspace files to move.
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=conv.folder_id, conversation_id=conversation_id
    )
    try:
        # Folder lock (决策④): serialize the move against a running same-folder turn.
        async with workspace_lock(key):
            await move_file(
                user_id=user.user_id,
                folder_id=conv.folder_id,
                conversation_id=conversation_id,
                src=body.src,
                dst=body.dst,
            )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except PathNotFound as e:
        raise NotFoundError("文件不存在") from e
    except AlreadyExists as e:
        raise ValidationError("已存在同名文件") from e
    return StatusResponse()


@router.post("/{conversation_id}/workspace/dirs", response_model=StatusResponse)
async def create_workspace_dir(
    conversation_id: str,
    body: CreateDirRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Create a directory in the conversation's workspace (promotes a 裸聊 first)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    folder_id = await _conv_write_folder(
        conv, conv_repo=conv_repo, folder_repo=folder_repo, user_id=user.user_id
    )
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    try:
        # Folder lock (决策④): serialize against a running same-folder turn.
        async with workspace_lock(key):
            await create_dir(
                user_id=user.user_id,
                folder_id=folder_id,
                conversation_id=conversation_id,
                path=body.path,
            )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except AlreadyExists as e:
        raise ValidationError("已存在同名文件或文件夹") from e
    return StatusResponse()


@router.post("/{conversation_id}/workspace/clone", response_model=CloneRepoResponse)
async def clone_repo_into_workspace(
    conversation_id: str,
    body: CloneRepoRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Clone a public git repository into the conversation's workspace (决策⑤).

    Cloning into a 裸聊 promotes it into a folder workspace first (§懒建)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    folder_id = await _conv_write_folder(
        conv, conv_repo=conv_repo, folder_repo=folder_repo, user_id=user.user_id
    )
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    try:
        # Folder lock (决策④): the clone writes many files; serialize it against a
        # running same-folder turn and other workspace mutations.
        async with workspace_lock(key):
            dest = await clone_repo(
                user_id=user.user_id,
                folder_id=folder_id,
                conversation_id=conversation_id,
                repo_url=body.repo_url,
                dest=body.dest,
            )
    except ValueError as e:
        raise ValidationError(str(e)) from e
    except CloneError as e:
        raise ValidationError(f"克隆失败：{e}") from e
    return CloneRepoResponse(path=dest)
