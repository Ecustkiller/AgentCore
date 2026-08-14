"""User workflow CRUD + run-once (direct-start bypass) + official playbook copy.

Slot suggestion (``POST /workflows/{id}/suggest-slots``) also lives here: it is a
before-you-run step, not a save-time one — see
:mod:`agentcore.workflows.slot_extract`.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from agentcore.api.dependencies import (
    AuthUser,
    get_folder_repo,
    get_user_workflow_repo,
)
from agentcore.api.schemas import StatusResponse
from agentcore.api.schemas.workflows import (
    CreateWorkflowRequest,
    FromPlaybookRequest,
    PlaybookTemplateSummary,
    RunWorkflowRequest,
    RunWorkflowResponse,
    UpdateWorkflowRequest,
    WorkflowSummary,
)
from agentcore.core.errors import NotFoundError, ValidationError
from agentcore.db.repositories import FolderRepository, UserWorkflowRepository
from agentcore.workflows.playbook_templates import (
    PlaybookTemplateError,
    instantiate_from_playbook,
    list_playbook_templates,
)
from agentcore.workflows.runner import dispatch_workflow_run
from agentcore.workflows.slot_extract import (
    append_description_note,
    slots_note,
    suggest_slots_for_definition,
)
from agentcore.workflows.slots import slots_from_definition
from agentcore.workflows.source import is_turn_sourced

router = APIRouter(tags=["workflows"])


def _require_folder(folder) -> None:
    if folder is None:
        raise NotFoundError("工作区不存在")


@router.get("/workflows", response_model=list[WorkflowSummary])
async def list_workflows(
    user: AuthUser,
    repo: UserWorkflowRepository = Depends(get_user_workflow_repo),
):
    rows = await repo.list_by_user(user.user_id)
    return [WorkflowSummary.from_row(r) for r in rows]


@router.get(
    "/workflow-playbook-templates",
    response_model=list[PlaybookTemplateSummary],
)
async def list_workflow_playbook_templates(user: AuthUser):
    """Official playbooks as read-only workflow templates (使用 = 复制为我的)."""
    _ = user
    return [
        PlaybookTemplateSummary.model_validate(item)
        for item in list_playbook_templates()
    ]


@router.post("/workflows", response_model=WorkflowSummary, status_code=201)
async def create_workflow(
    body: CreateWorkflowRequest,
    user: AuthUser,
    repo: UserWorkflowRepository = Depends(get_user_workflow_repo),
):
    row = await repo.create(
        user_id=user.user_id,
        name=body.name,
        description=body.description,
        definition=body.definition.payload(),
    )
    return WorkflowSummary.from_row(row)


@router.post(
    "/workflows/from-playbook",
    response_model=WorkflowSummary,
    status_code=201,
)
async def create_workflow_from_playbook(
    body: FromPlaybookRequest,
    user: AuthUser,
    repo: UserWorkflowRepository = Depends(get_user_workflow_repo),
):
    """Expand an official playbook once and save as a user workflow (not into PLAYBOOKS)."""
    try:
        name, description, definition = instantiate_from_playbook(
            body.playbook,
            body.slots,
            name=body.name,
        )
    except PlaybookTemplateError as e:
        raise ValidationError(str(e)) from e
    row = await repo.create(
        user_id=user.user_id,
        name=name,
        description=description,
        definition=definition,
    )
    return WorkflowSummary.from_row(row)


@router.get("/workflows/{workflow_id}", response_model=WorkflowSummary)
async def get_workflow(
    workflow_id: str,
    user: AuthUser,
    repo: UserWorkflowRepository = Depends(get_user_workflow_repo),
):
    row = await repo.get_by_id(workflow_id, user_id=user.user_id)
    if row is None:
        raise NotFoundError("工作流不存在")
    return WorkflowSummary.from_row(row)


@router.patch("/workflows/{workflow_id}", response_model=WorkflowSummary)
async def update_workflow(
    workflow_id: str,
    body: UpdateWorkflowRequest,
    user: AuthUser,
    repo: UserWorkflowRepository = Depends(get_user_workflow_repo),
):
    desc_arg: object = ...
    if body.clear_description or body.description is not None:
        desc_arg = None if body.clear_description else body.description
    row = await repo.update(
        workflow_id,
        user_id=user.user_id,
        name=body.name,
        description=desc_arg,
        definition=body.definition.payload() if body.definition is not None else None,
    )
    if row is None:
        raise NotFoundError("工作流不存在")
    return WorkflowSummary.from_row(row)


@router.delete("/workflows/{workflow_id}", response_model=StatusResponse)
async def delete_workflow(
    workflow_id: str,
    user: AuthUser,
    repo: UserWorkflowRepository = Depends(get_user_workflow_repo),
):
    ok = await repo.delete(workflow_id, user_id=user.user_id)
    if not ok:
        raise NotFoundError("工作流不存在")
    return StatusResponse()


@router.post("/workflows/{workflow_id}/suggest-slots", response_model=WorkflowSummary)
async def suggest_workflow_slots(
    workflow_id: str,
    user: AuthUser,
    repo: UserWorkflowRepository = Depends(get_user_workflow_repo),
):
    """抽出「上一次的具体输入」并写回 definition（前端第一次点「跑一次」时调）。

    从一轮协作固化出来的工作流，任务描述里写死的是那一次的主题——用户第二次要用它才会撞上
    这件事，所以这一次背景模型调用挂在这里而不是保存路径上。抽到了就连占位符带 ``slots``
    一起落库，以后再跑不用重抽。

    三种「不抽」都返回**与调用前逐字一致**的 definition（不是报错）：已经有槽位（幂等）、
    不是固化来源（官方模板自带槽位、手画的归用户管）、抽槽本身失败或没认出可验证的片段。
    前端拿到没有 ``slots`` 的 definition 就照常直接跑。
    """
    row = await repo.get_by_id(workflow_id, user_id=user.user_id)
    if row is None:
        raise NotFoundError("工作流不存在")
    definition = dict(row.definition or {})
    # 来源读的是列，不是 definition：客户端在画布里塞一个 ``source`` 骗不出抽槽。
    if slots_from_definition(definition) or not is_turn_sourced(row.source):
        return WorkflowSummary.from_row(row)

    definition, slots = await suggest_slots_for_definition(
        definition, user_id=user.user_id
    )
    if not slots:
        return WorkflowSummary.from_row(row)

    updated = await repo.update(
        workflow_id,
        user_id=user.user_id,
        definition=definition,
        description=append_description_note(row.description or "", slots_note(slots)),
    )
    if updated is None:
        raise NotFoundError("工作流不存在")
    return WorkflowSummary.from_row(updated)


@router.post("/workflows/{workflow_id}/run", response_model=RunWorkflowResponse)
async def run_workflow(
    workflow_id: str,
    body: RunWorkflowRequest,
    user: AuthUser,
    folders: FolderRepository = Depends(get_folder_repo),
    repo: UserWorkflowRepository = Depends(get_user_workflow_repo),
):
    row = await repo.get_by_id(workflow_id, user_id=user.user_id)
    if row is None:
        raise NotFoundError("工作流不存在")
    folder = await folders.get_by_id(body.folder_id, user_id=user.user_id)
    _require_folder(folder)
    try:
        conversation_id = await dispatch_workflow_run(
            user_id=user.user_id,
            workflow_id=row.id,
            workflow_version=int(row.version or 1),
            definition=dict(row.definition or {}),
            folder_id=body.folder_id,
            note=body.note,
            conversation_id=body.conversation_id,
            workflow_name=row.name,
            slot_values=body.slots or None,
        )
    except LookupError as e:
        raise NotFoundError(str(e) or "资源不存在") from e
    except ValueError as e:
        raise ValidationError(str(e)) from e
    return RunWorkflowResponse(
        conversation_id=conversation_id,
        workflow_id=row.id,
        workflow_version=int(row.version or 1),
    )
