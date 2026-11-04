"""Opt-in lab scheduled jobs API (生成 / 最后修订 2026-11-04).

⚠️ 本地实验，与上游「定时代跑否决 / 不是远期」口径相悖，用户 2026-11-04
裁定为 opt-in 默认关。**开关关时所有端点一律 404**，且 lifespan 不挂 loop、
不写任何行 —— 默认行为与上游完全一致。详见 config/lab_schedule.py。

只做「到点给一个 URL 发 HMAC 签名通知」，不启动 AI 回合、不代跑 agent。
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import AuthUser, get_db
from agentcore.config import settings
from agentcore.core.net import classify_url
from agentcore.db.models import LabScheduledJob
from agentcore.lab_schedule import (
    create_job,
    delete_job,
    due_from_job,
    fire_job,
    get_job,
    list_jobs,
    validate_schedule,
)

router = APIRouter(prefix="/lab/scheduled-jobs", tags=["lab-scheduled-jobs"])


class CreateLabJobRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    interval_seconds: int = Field(ge=30, le=86400)
    webhook_url: str = Field(min_length=1, max_length=2000)
    # 接收方用同一个 secret 复算 HMAC-SHA256 校验 X-Nexus-Lab-Signature。
    secret: str = Field(min_length=8, max_length=512)
    payload: dict[str, Any] = Field(default_factory=dict)


class LabJobView(BaseModel):
    id: str
    name: str
    interval_seconds: int
    webhook_url: str
    enabled: bool
    next_run_at: datetime
    last_run_at: datetime | None
    last_status: str | None
    created_at: datetime


class LabJobFireResponse(BaseModel):
    status: str


def _gate() -> None:
    """默认关 = 404（不暴露实验面的存在，也不给探测面）。"""
    if not settings.lab_scheduled_jobs_enabled:
        raise HTTPException(status_code=404, detail="Not found")


def _view(job: LabScheduledJob) -> LabJobView:
    return LabJobView(
        id=job.id,
        name=job.name,
        interval_seconds=job.interval_seconds,
        webhook_url=job.webhook_url,
        enabled=job.enabled,
        next_run_at=job.next_run_at,
        last_run_at=job.last_run_at,
        last_status=job.last_status,
        created_at=job.created_at,
    )


@router.get("", response_model=list[LabJobView])
async def list_lab_jobs(
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
) -> list[LabJobView]:
    _gate()
    return [_view(job) for job in await list_jobs(session, user.user_id)]


@router.post("", response_model=LabJobView)
async def create_lab_job(
    body: CreateLabJobRequest,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
) -> LabJobView:
    _gate()
    problem = validate_schedule(
        interval_seconds=body.interval_seconds,
        webhook_url=body.webhook_url,
        secret=body.secret,
    )
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    block = await classify_url(body.webhook_url)
    if block is not None:
        raise HTTPException(
            status_code=400, detail=f"webhook_url 被 SSRF 守卫拒绝：{block.name}"
        )
    try:
        job = await create_job(
            session,
            user_id=user.user_id,
            name=body.name,
            interval_seconds=body.interval_seconds,
            webhook_url=body.webhook_url,
            secret=body.secret,
            payload=body.payload,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="实验功能密钥存储不可用") from exc
    return _view(job)


@router.post("/{job_id}/fire", response_model=LabJobFireResponse)
async def fire_lab_job(
    job_id: str,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
) -> LabJobFireResponse:
    """手动触发一次，便于验证签名与出站；不改动 next_run_at。"""
    _gate()
    job = await get_job(session, user.user_id, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Not found")
    status = await fire_job(due_from_job(job))
    # 用请求自己的 session 落状态：另开 session 盲 UPDATE 会与本次会话的
    # identity map 不一致（读侧看到的仍是触发前的 last_status）。
    job.last_status = status
    job.last_run_at = datetime.now(UTC)
    await session.commit()
    return LabJobFireResponse(status=status)


@router.delete("/{job_id}")
async def delete_lab_job(
    job_id: str,
    user: AuthUser,
    session: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    _gate()
    if not await delete_job(session, user.user_id, job_id):
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}
