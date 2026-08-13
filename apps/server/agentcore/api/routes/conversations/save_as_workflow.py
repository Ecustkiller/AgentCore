"""把一轮已跑完的多队员协作固化成用户工作流（工作流的主入口）。

想要工作流的时刻必然是刚跑完一轮满意的协作，而不是去二级页面从零画 DAG——所以入口挂在
回合上，而不是工作流列表页。归一逻辑在 :mod:`agentcore.workflows.from_turn`，这里只做
owner 校验、幂等短路与落库。

**这条路上不调模型**：用户按下保存时想的是「这轮不错先存下来」，任何背景调用都只是让他多
等。参数化（抽槽）改挂在按需端点 ``POST /v1/workflows/{id}/suggest-slots``，前端在用户第
一次点「跑一次」时才调 —— 见 :mod:`agentcore.workflows.slot_extract`。落库的 definition
里任务描述就是原轮原文。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_message_repo,
    get_turn_journal_repo,
    get_user_workflow_repo,
)
from agentcore.api.schemas.workflows import SaveTurnAsWorkflowRequest, WorkflowSummary
from agentcore.core.errors import NotFoundError, ValidationError
from agentcore.core.logging import get_logger
from agentcore.db.repositories import (
    ConversationRepository,
    MessageRepository,
    TurnJournalRepository,
    UserWorkflowRepository,
)
from agentcore.workflows.from_turn import (
    TurnWorkflowError,
    draft_workflow_from_journal,
)

from ._helpers import _require_owned_conversation

router = APIRouter(prefix="/conversations", tags=["conversations"])

logger = get_logger(__name__)


@router.post(
    "/{conversation_id}/messages/{message_id}/save-as-workflow",
    response_model=WorkflowSummary,
)
async def save_turn_as_workflow(
    conversation_id: str,
    message_id: str,
    user: AuthUser,
    body: SaveTurnAsWorkflowRequest | None = None,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    msg_repo: MessageRepository = Depends(get_message_repo),
    journal_repo: TurnJournalRepository = Depends(get_turn_journal_repo),
    workflow_repo: UserWorkflowRepository = Depends(get_user_workflow_repo),
) -> WorkflowSummary:
    """固化这一回合的团队拆法为账户级工作流（owner-scoped，同源幂等）。

    幂等只认来源（``user_workflows.source`` 列上的 conversation_id + message_id），不认
    ``name``：同一轮再点一次保存返回已有那条，想要「同一轮多个变体」走保存后改名 / 另存，
    而不是靠这个端点的隐藏分支。来源是服务端权威元数据、不在客户端能覆盖的 definition 里
    （:mod:`agentcore.workflows.source`），所以这里能直接走索引查。422 = 这轮压根没有多队
    员协作（无计划快照或有效节点 < 2），或整轮只有辩论（辩论不写计划快照，折不出画布）。
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    turn = await msg_repo.get_by_id(message_id, conversation_id=conversation_id)
    if turn is None or turn.role != "assistant":
        raise NotFoundError("回合不存在")

    existing = await workflow_repo.find_by_turn_source(
        user_id=user.user_id,
        conversation_id=conversation_id,
        message_id=message_id,
    )
    if existing is not None:
        return WorkflowSummary.from_row(existing)

    entries = await journal_repo.load_owned(message_id, conversation_id)
    try:
        draft = draft_workflow_from_journal(
            entries,
            conversation_id=conversation_id,
            message_id=message_id,
            name=body.name if body is not None else None,
        )
    except TurnWorkflowError as e:
        raise ValidationError(str(e)) from e

    row = await workflow_repo.create(
        user_id=user.user_id,
        name=draft.name,
        description=draft.description,
        definition=draft.definition,
        source=draft.source,
    )
    logger.info(
        "workflow.saved_from_turn",
        conversation_id=conversation_id,
        message_id=message_id,
        workflow_id=row.id,
        node_count=draft.node_count,
    )
    return WorkflowSummary.from_row(row)
