"""文件编辑辅助路由（AI 改写）。

这里是**无状态**的文本助手：服务端从不读写文件本身（本地文件在桌面 fs 桥后、云端文件
在工作区 API 后），编辑器把「选区 + 指令 + 前后文」作为文本发来，拿回改写版后由前端逐块
评审落地。无持久化、无文件路径——纯文本进、文本出，按 ``scenario="file.rewrite"`` 归因花费。

计费门禁与对话回合一致（成本配额与计费.md §一）：BYOK 模式要求用户自带 DeepSeek key
（缺则 402 LLM_KEY_REQUIRED），平台模式走配额并使用全局 key。
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import AuthUser, get_cost_event_repo, get_db
from agentcore.api.schemas import RewriteRequest, RewriteResponse
from agentcore.assist.rewrite import RewriteInput, rewrite_selection
from agentcore.config import settings
from agentcore.conversation.quota import QuotaLimits, enforce_quota
from agentcore.core.errors import BYOKKeyMissingError
from agentcore.db.models import User
from agentcore.db.repositories import CostEventRepository
from agentcore.llm.byok import LLMCredentials, resolve_user_llm_credentials
from agentcore.llm.factory import build_provider

router = APIRouter(prefix="/files", tags=["files"])


async def _resolve_assist_credentials(
    *,
    session: AsyncSession,
    user: User,
    cost_repo: CostEventRepository,
) -> LLMCredentials | None:
    """一次性文件辅助调用的计费门禁，与回合 preflight 同决策。

    BYOK 模式要求用户自己的 DeepSeek key（缺失 → 402 LLM_KEY_REQUIRED，前端引导去
    设置·模型配置）；平台模式校验用量配额并退回全局 key（``None``）。
    """
    if settings.billing_mode == "byok":
        credentials = await resolve_user_llm_credentials(session, user.user_id)
        if credentials is None:
            raise BYOKKeyMissingError(
                "请先在「设置 · 模型配置」中填入你的 DeepSeek API Key，再使用 AI 改写。"
            )
        return credentials
    await enforce_quota(cost_repo, user.user_id, limits=QuotaLimits.for_user(user))
    return None


@router.post("/assist/rewrite", response_model=RewriteResponse)
async def rewrite_file_selection(
    body: RewriteRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
) -> RewriteResponse:
    """按自由指令改写文档中的一段选区。

    无状态、无路径：入参携带选区与前后文文本，返回改写后的选区，交前端用 merge view
    逐块评审。全程不落库。
    """
    credentials = await _resolve_assist_credentials(
        session=session, user=user, cost_repo=cost_repo
    )
    provider = build_provider(credentials)
    rewritten = await rewrite_selection(
        provider,
        RewriteInput(
            selection=body.selection,
            instruction=body.instruction,
            context_before=body.context_before,
            context_after=body.context_after,
        ),
    )
    return RewriteResponse(rewritten=rewritten)
