"""Global search route (全局搜索 Tier 1: 跨对话/消息/文件夹关键词检索).

One keyword query fans out over the authenticated user's own conversations
(title), messages (content) and folders (name) — see
``docs/04-前端/前端技术与架构.md`` §9.8. Each entity is searched by its repo
(ILIKE substring, owner-scoped, recency-ordered); the three queries run
sequentially because they share one ``AsyncSession`` (not concurrency-safe). The
implementation is ILIKE rather than ``to_tsvector`` on purpose: stock PostgreSQL
does not segment Chinese, so FTS would under-recall this product's content (§6.3).
"""

from fastapi import APIRouter, Depends, Query

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_folder_repo,
    get_message_repo,
)
from agentcore.api.schemas import SearchItem, SearchResponse, SearchSection
from agentcore.db.repositories import (
    ConversationRepository,
    FolderRepository,
    MessageRepository,
)

router = APIRouter(prefix="/search", tags=["search"])

# The entity types Tier 1 searches, in section render order. IM chats / users are
# out of scope (they have their own people-search + list filter, §八 决策②).
_ALL_TYPES: tuple[str, ...] = ("conversation", "message", "folder")

# A message hit's snippet shows this many characters on each side of the match,
# so the user sees enough context to recognise the line without the whole body.
_SNIPPET_RADIUS = 40


def _parse_types(types: str | None) -> set[str]:
    """Resolve the optional ``types`` CSV filter to a set of valid entity types.

    Absent or all-invalid input falls back to every type (lenient — a typo
    shouldn't silently return nothing).
    """
    if not types:
        return set(_ALL_TYPES)
    requested = {t.strip() for t in types.split(",") if t.strip()}
    return (requested & set(_ALL_TYPES)) or set(_ALL_TYPES)


def _message_snippet(content: str, query: str) -> tuple[str, int | None, int | None]:
    """Build a match-centered snippet plus the match's offsets within it.

    Returns ``(snippet, match_start, match_end)`` where the offsets index into the
    returned snippet (so the client highlights without re-searching). Ellipses mark
    truncation on either side and are accounted for in the offsets. If the match
    can't be located (shouldn't happen — ILIKE already matched), falls back to a
    plain prefix with no offsets.
    """
    idx = content.lower().find(query.lower())
    if idx < 0:
        return content[: _SNIPPET_RADIUS * 2], None, None
    start = max(0, idx - _SNIPPET_RADIUS)
    end = min(len(content), idx + len(query) + _SNIPPET_RADIUS)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(content) else ""
    snippet = f"{prefix}{content[start:end]}{suffix}"
    match_start = len(prefix) + (idx - start)
    match_end = match_start + len(query)
    return snippet, match_start, match_end


@router.get("", response_model=SearchResponse)
async def search(
    user: AuthUser,
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(8, ge=1, le=20),
    types: str | None = Query(None),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    msg_repo: MessageRepository = Depends(get_message_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Keyword search across the user's conversations, messages and folders.

    ``limit`` caps each section independently; ``types`` (CSV of
    ``conversation,message,folder``) narrows which sections are searched. Empty
    sections are omitted. Every result is owner-scoped — a non-owner's data never
    appears.
    """
    wanted = _parse_types(types)
    sections: list[SearchSection] = []

    if "conversation" in wanted:
        convs = await conv_repo.search(user.user_id, q, limit=limit)
        if convs:
            sections.append(
                SearchSection(
                    type="conversation",
                    items=[
                        SearchItem(id=c.id, title=c.title, updated_at=c.updated_at) for c in convs
                    ],
                )
            )

    if "message" in wanted:
        hits = await msg_repo.search(user.user_id, q, limit=limit)
        if hits:
            items: list[SearchItem] = []
            for msg, conv_title in hits:
                snippet, match_start, match_end = _message_snippet(msg.content or "", q)
                items.append(
                    SearchItem(
                        id=msg.id,
                        conversation_id=msg.conversation_id,
                        title=conv_title,
                        role=msg.role,
                        snippet=snippet,
                        match_start=match_start,
                        match_end=match_end,
                        updated_at=msg.created_at,
                    )
                )
            sections.append(SearchSection(type="message", items=items))

    if "folder" in wanted:
        folders = await folder_repo.search(user.user_id, q, limit=limit)
        if folders:
            sections.append(
                SearchSection(
                    type="folder",
                    items=[
                        SearchItem(id=f.id, title=f.name, updated_at=f.updated_at) for f in folders
                    ],
                )
            )

    return SearchResponse(query=q, sections=sections)
