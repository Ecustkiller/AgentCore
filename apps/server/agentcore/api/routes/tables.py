"""Creation-tool 多维表格 CRUD + ops (account-scoped; 外人 404)."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import AuthUser, get_db
from agentcore.api.schemas import (
    CreateTableRequest,
    StatusResponse,
    TableConversationResponse,
    TableDetail,
    TableOpsRequest,
    TableOpsResult,
    TableSummary,
    UpdateTableRequest,
)
from agentcore.core.errors import ConflictError, NotFoundError, ValidationError
from agentcore.db.repositories import ConversationRepository
from agentcore.db.repositories.tables import TableRepository
from agentcore.table.constants import STRUCT_OPS, TITLE_MAX
from agentcore.table.ops import apply_ops
from agentcore.table.state import TableState

router = APIRouter(prefix="/tables", tags=["tables"])

_DEFAULT_TITLE = "未命名表格"


def _detail(state: TableState) -> TableDetail:
    return TableDetail(
        id=state.id,
        title=state.title,
        conversation_id=state.conversation_id,
        schema_version=state.schema_version,
        columns=state.columns,  # type: ignore[arg-type]
        rows=state.rows,  # type: ignore[arg-type]
        views=state.views,  # type: ignore[arg-type]
        active_view_id=state.active_view_id,
        created_at=state.created_at,  # type: ignore[arg-type]
        updated_at=state.updated_at,  # type: ignore[arg-type]
    )


@router.post("", response_model=TableDetail, status_code=201)
async def create_table(
    body: CreateTableRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
):
    title = (body.title or _DEFAULT_TITLE).strip()[:TITLE_MAX] or _DEFAULT_TITLE
    repo = TableRepository(session)
    state = await repo.create(user_id=user.user_id, title=title)
    return _detail(state)


@router.get("", response_model=list[TableSummary])
async def list_tables(
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
):
    repo = TableRepository(session)
    rows = await repo.list_by_user(user.user_id)
    return [TableSummary.model_validate(r) for r in rows]


@router.get("/{table_id}", response_model=TableDetail)
async def get_table(
    table_id: str,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
):
    repo = TableRepository(session)
    state = await repo.get_state(table_id, user_id=user.user_id)
    if not state:
        raise NotFoundError("表格不存在")
    return _detail(state)


@router.patch("/{table_id}", response_model=TableSummary)
async def update_table(
    table_id: str,
    body: UpdateTableRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
):
    repo = TableRepository(session)
    title = (body.title or "").strip()[:TITLE_MAX]
    if not title:
        raise ValidationError("标题不能为空")
    table = await repo.update_title(table_id, user_id=user.user_id, title=title)
    if not table:
        raise NotFoundError("表格不存在")
    listed = await repo.list_by_user(user.user_id)
    row = next((r for r in listed if r["id"] == table_id), None)
    if not row:
        raise NotFoundError("表格不存在")
    return TableSummary.model_validate(row)


@router.post("/{table_id}/ops", response_model=TableOpsResult)
async def apply_table_ops(
    table_id: str,
    body: TableOpsRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
):
    repo = TableRepository(session)
    state = await repo.get_state(table_id, user_id=user.user_id)
    if not state:
        raise NotFoundError("表格不存在")
    if (
        body.schema_baseline is not None
        and any((op.get("op") in STRUCT_OPS) for op in body.ops)
        and body.schema_baseline != state.schema_version
    ):
        raise ConflictError("表格结构已更新，请刷新后再改列")
    result = apply_ops(state, body.ops, confirm=body.confirm)
    if result.refused or (not result.ok and result.error):
        return TableOpsResult(
            ok=False,
            level=result.level,
            summary=result.summary,
            error=result.error,
            table=_detail(state),
        )
    if result.needs_confirmation or result.state is None:
        return TableOpsResult(
            ok=True,
            level=result.level,
            summary=result.summary,
            needs_confirmation=True,
            batch_id=result.batch_id,
            table=_detail(state),
        )
    await repo.persist_state(
        result.state,
        touched_row_ids=result.touched_row_ids,
        deleted_row_ids=result.deleted_row_ids,
    )
    fresh = await repo.get_state(table_id, user_id=user.user_id)
    return TableOpsResult(
        ok=True,
        level=result.level,
        summary=result.summary,
        batch_id=result.batch_id,
        table=_detail(fresh) if fresh else None,
    )


@router.post("/{table_id}/conversation", response_model=TableConversationResponse)
async def ensure_table_conversation(
    table_id: str,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
):
    tables = TableRepository(session)
    table = await tables.get_by_id(table_id, user_id=user.user_id)
    if not table:
        raise NotFoundError("表格不存在")
    if table.conversation_id:
        return TableConversationResponse(conversation_id=table.conversation_id)
    conversations = ConversationRepository(session)
    conv = await conversations.create(
        user_id=user.user_id,
        title=table.title or _DEFAULT_TITLE,
        folder_id=None,
        commit=False,
    )
    await tables.attach_conversation(
        table_id, user_id=user.user_id, conversation_id=conv.id, commit=True
    )
    return TableConversationResponse(conversation_id=conv.id)


@router.delete("/{table_id}", response_model=StatusResponse)
async def delete_table(
    table_id: str,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
):
    repo = TableRepository(session)
    deleted = await repo.soft_delete(table_id, user_id=user.user_id)
    if not deleted:
        raise NotFoundError("表格不存在")
    return StatusResponse()
