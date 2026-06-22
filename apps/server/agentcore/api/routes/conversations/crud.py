"""Conversation CRUD: create / list / grouped / get / update / move / delete / export.

Every route requires an authenticated user and is scoped to that user's own
conversations: reads/writes pass ``user_id`` into the repository so a non-owner
receives 404 (never another user's data — IDOR-safe).
"""

import json
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Response

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_conversation_share_repo,
    get_folder_repo,
    get_message_repo,
    get_model_mode_repo,
)
from agentcore.api.routes.model_modes import validate_mode_ref
from agentcore.api.schemas import (
    ConversationListResponse,
    ConversationSummary,
    CreateConversationRequest,
    FolderGroup,
    GroupedConversationsResponse,
    MoveConversationRequest,
    StatusResponse,
    UpdateConversationRequest,
)
from agentcore.conversation.export import (
    conversation_to_json,
    conversation_to_markdown,
)
from agentcore.core.errors import ConflictError, NotFoundError
from agentcore.db.models import Conversation
from agentcore.db.repositories import (
    ConversationRepository,
    ConversationShareRepository,
    FolderRepository,
    MessageRepository,
    ModelModeRepository,
)

from ._helpers import _get_owned_conversation

router = APIRouter(prefix="/conversations", tags=["conversations"])


def _summary_with_count(conv: Conversation, counts: dict[str, int]) -> ConversationSummary:
    """Build a conversation summary, filling ``message_count`` from a counts map.

    The list/grouped endpoints precompute counts in one query (see
    ``MessageRepository.counts_for_conversations``) and pass the map here so the
    sidebar gets each chat's count without an N+1; absent ids default to 0.
    """
    summary = ConversationSummary.model_validate(conv)
    summary.message_count = counts.get(conv.id, 0)
    return summary


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
        # Desktop's local-first lazy-promote intent (工作区对称化 D1a), stored so every
        # promotion path (turn / panel) later agrees on locality. Moot once foldered —
        # a foldered chat inherits its folder's binding — so only record it for a 裸聊.
        local_container_root_id=(body.local_container_root_id if body.folder_id is None else None),
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
        conv = await repo.set_model_mode(conversation_id, body.model_mode, user_id=user.user_id)
    # Sidebar housekeeping toggles (对话基础功能补齐): pin floats the row to the top,
    # archive hides it from the live list (both reversible, no tri-state → a null is
    # ignored as「unchanged」).
    if "pinned" in fields and body.pinned is not None:
        conv = await repo.set_pinned(conversation_id, body.pinned, user_id=user.user_id)
    if "archived" in fields and body.archived is not None:
        conv = await repo.set_archived(conversation_id, body.archived, user_id=user.user_id)
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
        conv = await conv_repo.set_folder(conversation_id, body.folder_id, user_id=user.user_id)
        if not conv:
            raise NotFoundError("对话不存在")
    return ConversationSummary.model_validate(conv)


@router.delete("/{conversation_id}", response_model=StatusResponse)
async def delete_conversation(
    conversation_id: str,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
    share_repo: ConversationShareRepository = Depends(get_conversation_share_repo),
):
    deleted = await repo.soft_delete(conversation_id, user_id=user.user_id)
    if not deleted:
        raise NotFoundError("对话不存在")
    # Cascade-revoke any public share links (分享对话): deleting a conversation must
    # kill its read-only links so a stale snapshot can't outlive it. Owner already
    # proven by the soft_delete above, so a blanket per-conversation revoke is safe.
    await share_repo.revoke_all_for_conversation(conversation_id)
    return StatusResponse()


def _download_headers(filename: str) -> dict[str, str]:
    """Content-Disposition for a download, with an RFC 5987 UTF-8 ``filename*``.

    A conversation title can be non-ASCII (Chinese), which a bare ``filename=`` can't
    carry; ``filename*=UTF-8''<pct-encoded>`` does, with a sanitized ASCII
    ``filename=`` fallback for older clients.
    """
    ascii_fallback = filename.encode("ascii", "ignore").decode("ascii") or "conversation"
    quoted = quote(filename, safe="")
    return {
        "Content-Disposition": (
            f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quoted}"
        )
    }


def _safe_export_stem(title: str, conversation_id: str) -> str:
    """A filesystem-safe base name for an export file, derived from the title.

    Strips path separators / control chars and caps the length; falls back to the
    conversation id when the title is empty or strips to nothing.
    """
    cleaned = "".join(
        ch for ch in (title or "") if ch.isprintable() and ch not in '/\\:*?"<>|'
    ).strip()
    cleaned = cleaned[:80].strip()
    return cleaned or f"conversation-{conversation_id[:8]}"


@router.get("/{conversation_id}/export")
async def export_conversation(
    conversation_id: str,
    user: AuthUser,
    format: str = Query("md", pattern="^(md|json)$"),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    msg_repo: MessageRepository = Depends(get_message_repo),
):
    """Export a conversation's full transcript as a download (导出对话).

    Reads the WHOLE transcript server-side (not a scroll window, so nothing is
    missed) and renders it owner-scoped (404 for a non-owner). ``format=md`` is a
    clean, content-only Markdown record (the default a user reads / pastes);
    ``format=json`` is a full-fidelity dump for power users / re-import. Spend is
    never exported — it lives in the cost ledger, not the message body.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    messages = await msg_repo.list_all_for_conversation(conversation_id)
    stem = _safe_export_stem(conv.title, conversation_id)
    if format == "json":
        payload = conversation_to_json(conv, messages)
        content = json.dumps(payload, ensure_ascii=False, indent=2)
        return Response(
            content=content,
            media_type="application/json",
            headers=_download_headers(f"{stem}.json"),
        )
    content = conversation_to_markdown(conv, messages)
    return Response(
        content=content,
        media_type="text/markdown; charset=utf-8",
        headers=_download_headers(f"{stem}.md"),
    )
