"""Account narrow-ticket mint + engine surface for sidecar (R3a/R3b).

Desktop convention (parallel desktop inject):
- Mint: ``POST /v1/account/token`` with cookie/Bearer **access** session
  → ``{token, expires_in_sec}`` (``type=account`` JWT).
- Sidecar inject: ``accountAuth: {baseUrl, apiKey}`` where
  ``baseUrl`` = ``{apiOrigin}/v1/account`` and ``apiKey`` = minted token.
- Cloud calls (account ticket **or** access):
  ``POST {baseUrl}/conversations/search|read``,
  ``POST {baseUrl}/rules/list|remember`` (list = always + on_demand bodies for
  规则目录 / ``consult``),
  ``POST {baseUrl}/memory/{list,load,save,delete,project-scopes}``.
- Does **not** open UI conversation / documents / memory-editor CRUD to the
  narrow ticket — engine-minimal surface only.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import AccountApiUser, AuthUser, get_db
from agentcore.config import settings
from agentcore.conversation.log_export import (
    MAX_CHUNK_CHARS,
    chunk_transcript,
    render_conversation_log,
    search_snippet_from_messages,
)
from agentcore.db.repositories import (
    ConversationRepository,
    DocumentRepository,
    FolderRepository,
    MessageRepository,
    TurnJournalRepository,
)
from agentcore.memory.document_store import DocumentMemoryStore
from agentcore.memory.rules_injection import mutate_user_rule
from agentcore.security.tokens import create_account_token

router = APIRouter(prefix="/account", tags=["account"])

_SEARCH_HARD_CAP = 30
_DEFAULT_LIMIT = 10
_MAX_LOOKBACK_HOURS = 168


class AccountTokenResponse(BaseModel):
    """Freshly minted account narrow token + lifetime (sidecar log-tool auth).

    Desktop: ``baseUrl`` for ``accountAuth`` is ``{apiOrigin}/v1/account``;
    ``apiKey`` is ``token``. Mint path: ``POST /v1/account/token``.
    """

    token: str
    expires_in_sec: int


@router.post("/token", response_model=AccountTokenResponse)
async def mint_account_token(user: AuthUser) -> AccountTokenResponse:
    """Exchange the caller's cookie/Bearer access session for an account narrow ticket."""
    return AccountTokenResponse(
        token=create_account_token(user.user_id),
        expires_in_sec=settings.account_token_expire_minutes * 60,
    )


class ConversationSearchRequest(BaseModel):
    """Aligned with Worker ``search_conversations`` (resolved folder filters)."""

    query: str = ""
    folder_id: str | None = None
    include_archived: bool = False
    global_chats_only: bool = False
    exclude_conversation_id: str | None = None
    limit: int = Field(default=_DEFAULT_LIMIT, ge=1, le=_SEARCH_HARD_CAP)
    updated_within_hours: int | None = Field(default=None, ge=1, le=_MAX_LOOKBACK_HOURS)
    # When true, treat ``folder_id`` as an explicit owner-check target (tool's
    # explicit folder_id arg). Missing/unowned → ``folder_miss`` soft empty.
    check_folder_owned: bool = False


class ConversationSearchRow(BaseModel):
    conversation_id: str
    title: str
    folder_id: str | None = None
    folder_name: str | None = None
    updated_at: str | None = None
    message_count: int = 0
    archived: bool = False
    snippet: str | None = None


class ConversationSearchResponse(BaseModel):
    rows: list[ConversationSearchRow]
    folder_miss: bool = False


@router.post("/conversations/search", response_model=ConversationSearchResponse)
async def search_account_conversations(
    body: ConversationSearchRequest,
    user: AccountApiUser,
    session: AsyncSession = Depends(get_db),
) -> ConversationSearchResponse:
    """Owner-scoped conversation directory search (account ticket or access)."""
    if body.check_folder_owned and body.folder_id:
        folder = await FolderRepository(session).get_by_id(
            body.folder_id, user_id=user.user_id
        )
        if folder is None:
            return ConversationSearchResponse(rows=[], folder_miss=True)

    updated_after: datetime | None = None
    if body.updated_within_hours is not None:
        updated_after = datetime.now(UTC) - timedelta(hours=body.updated_within_hours)

    rows = await ConversationRepository(session).search_with_projections(
        user.user_id,
        (body.query or "").strip(),
        limit=body.limit,
        folder_id=body.folder_id,
        include_archived=body.include_archived,
        global_chats_only=body.global_chats_only,
        exclude_conversation_id=body.exclude_conversation_id or None,
        updated_after=updated_after,
    )
    msg_repo = MessageRepository(session)
    out_rows: list[ConversationSearchRow] = []
    for row in rows:
        snippet: str | None = None
        try:
            msgs = await msg_repo.list_all_for_conversation(row["conversation_id"])
            snippet = search_snippet_from_messages(msgs, (body.query or "").strip()) or None
        except Exception:  # noqa: BLE001 — snippet is best-effort
            snippet = None
        out_rows.append(
            ConversationSearchRow(
                conversation_id=row["conversation_id"],
                title=row["title"],
                folder_id=row.get("folder_id"),
                folder_name=row.get("folder_name"),
                updated_at=row.get("updated_at"),
                message_count=int(row.get("message_count") or 0),
                archived=bool(row.get("archived")),
                snippet=snippet,
            )
        )
    return ConversationSearchResponse(rows=out_rows, folder_miss=False)


class ConversationReadRequest(BaseModel):
    conversation_id: str
    cursor: str | None = None
    max_chars: int | None = Field(default=None, ge=1, le=MAX_CHUNK_CHARS)


class ConversationReadResponse(BaseModel):
    status: Literal["ok", "soft_miss"]
    title: str = ""
    conversation_id: str = ""
    transcript: str = ""
    truncated: bool = False
    next_cursor: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    message_count: int = 0
    char_offset: int = 0
    total_chars: int = 0


@router.post("/conversations/read", response_model=ConversationReadResponse)
async def read_account_conversation(
    body: ConversationReadRequest,
    user: AccountApiUser,
    session: AsyncSession = Depends(get_db),
) -> ConversationReadResponse:
    """Owner-scoped deep transcript read (account ticket or access). Soft miss on 404."""
    cid = (body.conversation_id or "").strip()
    if not cid:
        return ConversationReadResponse(status="soft_miss", conversation_id="")

    conv = await ConversationRepository(session).get_by_id(cid, user_id=user.user_id)
    if conv is None or conv.mode == "handoff":
        return ConversationReadResponse(status="soft_miss", conversation_id=cid)

    messages = list(await MessageRepository(session).list_all_for_conversation(cid))
    assistant_ids = [m.id for m in messages if m.role == "assistant"]
    journal_map = await TurnJournalRepository(session).load_map(assistant_ids)
    full = render_conversation_log(conv, messages, journal_map)
    cursor_s = (body.cursor or "").strip() or None
    chunk = chunk_transcript(
        full,
        conversation=conv,
        messages=messages,
        cursor=cursor_s,
        max_chars=body.max_chars,
    )
    return ConversationReadResponse(
        status="ok",
        title=chunk.title,
        conversation_id=chunk.conversation_id,
        transcript=chunk.transcript,
        truncated=chunk.truncated,
        next_cursor=chunk.next_cursor,
        started_at=chunk.started_at,
        ended_at=chunk.ended_at,
        message_count=chunk.message_count,
        char_offset=chunk.char_offset,
        total_chars=chunk.total_chars,
    )


# --- Engine-minimal rules / memory (R3b; not the UI documents/memory editors) ---


class AccountRulesListRequest(BaseModel):
    """Optional project layer; global rules always included."""

    folder_id: str | None = None


class AccountRuleDoc(BaseModel):
    name: str
    content: str


class AccountRulesListResponse(BaseModel):
    """Always rules for ``<rules>`` plus on_demand bodies for 规则目录 / ``consult``."""

    global_rules: list[AccountRuleDoc]
    project_rules: list[AccountRuleDoc]
    global_on_demand_rules: list[AccountRuleDoc] = Field(default_factory=list)
    project_on_demand_rules: list[AccountRuleDoc] = Field(default_factory=list)


@router.post("/rules/list", response_model=AccountRulesListResponse)
async def list_account_user_rules(
    body: AccountRulesListRequest,
    user: AccountApiUser,
    session: AsyncSession = Depends(get_db),
) -> AccountRulesListResponse:
    """User rules for turn assembly: always → ``<rules>``; on_demand → catalog + consult."""
    repo = DocumentRepository(session)
    global_docs = await repo.list_injectable_rules(
        user.user_id, None, ai_maintained=False
    )
    project_docs = []
    if body.folder_id:
        project_docs = await repo.list_injectable_rules(
            user.user_id, body.folder_id, ai_maintained=False
        )
    global_on_demand = await repo.list_on_demand_user_rules(user.user_id, None)
    project_on_demand = []
    if body.folder_id:
        project_on_demand = await repo.list_on_demand_user_rules(
            user.user_id, body.folder_id
        )
    return AccountRulesListResponse(
        global_rules=[
            AccountRuleDoc(name=d.name, content=d.content or "") for d in global_docs
        ],
        project_rules=[
            AccountRuleDoc(name=d.name, content=d.content or "") for d in project_docs
        ],
        global_on_demand_rules=[
            AccountRuleDoc(name=d.name, content=d.content or "") for d in global_on_demand
        ],
        project_on_demand_rules=[
            AccountRuleDoc(name=d.name, content=d.content or "")
            for d in project_on_demand
        ],
    )


class AccountRememberRequest(BaseModel):
    content: str | None = None
    folder_id: str | None = None
    action: Literal["add", "replace", "forget", "list"] = "add"
    replaces: str | None = None


class AccountRememberResponse(BaseModel):
    changed: bool
    action: str
    message: str
    rules_markdown: str | None = None


@router.post("/rules/remember", response_model=AccountRememberResponse)
async def remember_account_user_rule(
    body: AccountRememberRequest,
    user: AccountApiUser,
    session: AsyncSession = Depends(get_db),
) -> AccountRememberResponse:
    """Mutate the scope's user-rule doc (``add`` / ``replace`` / ``forget`` / ``list``)."""
    result = await mutate_user_rule(
        DocumentRepository(session),
        user.user_id,
        folder_id=body.folder_id,
        action=body.action,
        content=body.content,
        replaces=body.replaces,
    )
    return AccountRememberResponse(
        changed=result.changed,
        action=result.action,
        message=result.message,
        rules_markdown=result.rules_markdown,
    )


class AccountMemoryScopeRequest(BaseModel):
    scope: str | None = None


class AccountMemoryFileMeta(BaseModel):
    path: str
    version: str


class AccountMemoryListResponse(BaseModel):
    files: list[AccountMemoryFileMeta]


@router.post("/memory/list", response_model=AccountMemoryListResponse)
async def list_account_memory(
    body: AccountMemoryScopeRequest,
    user: AccountApiUser,
    session: AsyncSession = Depends(get_db),
) -> AccountMemoryListResponse:
    """List memory note paths under one scope (global when ``scope`` is null)."""
    store = DocumentMemoryStore(session)
    metas = await store.list(user.user_id, body.scope)
    return AccountMemoryListResponse(
        files=[AccountMemoryFileMeta(path=m.path, version=m.version) for m in metas]
    )


class AccountMemoryLoadRequest(BaseModel):
    path: str
    scope: str | None = None


class AccountMemoryLoadResponse(BaseModel):
    content: str


@router.post("/memory/load", response_model=AccountMemoryLoadResponse)
async def load_account_memory(
    body: AccountMemoryLoadRequest,
    user: AccountApiUser,
    session: AsyncSession = Depends(get_db),
) -> AccountMemoryLoadResponse:
    """Load one memory note body; missing path → empty string (soft)."""
    path = (body.path or "").strip()
    if not path:
        return AccountMemoryLoadResponse(content="")
    store = DocumentMemoryStore(session)
    content = await store.load(user.user_id, path, body.scope)
    return AccountMemoryLoadResponse(content=content)


class AccountMemorySaveRequest(BaseModel):
    path: str
    content: str
    scope: str | None = None


class AccountMemoryOkResponse(BaseModel):
    ok: bool = True


@router.post("/memory/save", response_model=AccountMemoryOkResponse)
async def save_account_memory(
    body: AccountMemorySaveRequest,
    user: AccountApiUser,
    session: AsyncSession = Depends(get_db),
) -> AccountMemoryOkResponse:
    """Upsert one memory note (画像/导航/主题/…). Write failures raise HTTP errors."""
    path = (body.path or "").strip()
    if not path:
        raise HTTPException(status_code=422, detail="path required")
    store = DocumentMemoryStore(session)
    await store.save(user.user_id, path, body.content, body.scope)
    return AccountMemoryOkResponse(ok=True)


class AccountMemoryDeleteRequest(BaseModel):
    path: str
    scope: str | None = None


@router.post("/memory/delete", response_model=AccountMemoryOkResponse)
async def delete_account_memory(
    body: AccountMemoryDeleteRequest,
    user: AccountApiUser,
    session: AsyncSession = Depends(get_db),
) -> AccountMemoryOkResponse:
    """Soft-delete one memory note (no-op if missing)."""
    path = (body.path or "").strip()
    if not path:
        raise HTTPException(status_code=422, detail="path required")
    store = DocumentMemoryStore(session)
    await store.delete(user.user_id, path, body.scope)
    return AccountMemoryOkResponse(ok=True)


class AccountMemoryProjectScopesResponse(BaseModel):
    scopes: list[str]


@router.post("/memory/project-scopes", response_model=AccountMemoryProjectScopesResponse)
async def list_account_memory_project_scopes(
    user: AccountApiUser,
    session: AsyncSession = Depends(get_db),
) -> AccountMemoryProjectScopesResponse:
    """Folder ids that hold a semantic project memory layer."""
    store = DocumentMemoryStore(session)
    scopes = await store.project_scopes(user.user_id)
    return AccountMemoryProjectScopesResponse(scopes=scopes)
