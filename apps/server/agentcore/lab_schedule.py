"""Opt-in lab: scheduled outbound notifications — policy + runner (生成 / 最后修订 2026-11-04).

⚠️ 用户 2026-11-04 裁定为本地实验（默认关）。上游已退役 clock/webhook proxy
runs 并把「定时代跑 / 无人值守」列为否决且「不是远期」，详见
``config/lab_schedule.py``。这里**不代跑任何 AI 回合**：到点只发一个 HMAC
签名的 HTTP 通知，接收方拿自己创建任务时给的 secret 校验签名。

分两段：
- 纯策略（``validate_schedule`` / ``sign_request`` / ``build_body`` /
  ``next_run_at``）——无 DB、无网络，可单测；
- runner（建/列/删、原子认领、出站、loop）——只在开关打开时才会被调用。

认领用 ``FOR UPDATE SKIP LOCKED`` 且**先把 next_run_at 推到未来再发**，
这样多实例不会重复触发、发失败也不会原地重试风暴。
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.core.net import classify_url, outbound_async_client
from agentcore.db.base import async_session_factory
from agentcore.db.models import LabScheduledJob

MAX_URL_LENGTH = 2000
MAX_SECRET_LENGTH = 512
MIN_SECRET_LENGTH = 8


@dataclass(frozen=True)
class DueJob:
    """An ORM-free snapshot — ``fire_job`` never touches a live session."""

    id: str
    name: str
    webhook_url: str
    secret_enc: bytes
    payload_json: str
    interval_seconds: int


# --------------------------------------------------------------------------- #
# 纯策略
# --------------------------------------------------------------------------- #


def validate_schedule(
    *, interval_seconds: int, webhook_url: str, secret: str
) -> str | None:
    """返回错误文案，或 None 表示可创建。SSRF 的 DNS 级判定在创建处另做（async）。"""
    if interval_seconds < settings.lab_scheduled_jobs_min_interval_seconds:
        return f"interval_seconds 不得小于 {settings.lab_scheduled_jobs_min_interval_seconds}"
    if not webhook_url or len(webhook_url) > MAX_URL_LENGTH:
        return "webhook_url 为空或过长"
    parsed = urlparse(webhook_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return "webhook_url 必须是 http(s) 绝对地址"
    if not MIN_SECRET_LENGTH <= len(secret) <= MAX_SECRET_LENGTH:
        return f"secret 长度须在 {MIN_SECRET_LENGTH}–{MAX_SECRET_LENGTH} 之间"
    return None


def next_run_at(now: datetime, interval_seconds: int) -> datetime:
    """从 now 起算下一次触发；不追赶错过的周期（避免重启后通知风暴）。"""
    return now + timedelta(seconds=interval_seconds)


def build_body(
    job_id: str, name: str, payload: dict[str, Any], now: datetime
) -> bytes:
    doc = {
        "type": "lab.scheduled_job.fired",
        "job_id": job_id,
        "name": name,
        "fired_at": now.isoformat(),
        "payload": payload,
    }
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()


def sign_request(secret: str, job_id: str, timestamp: int, body: bytes) -> str:
    """HMAC-SHA256 over ``<timestamp>.<job_id>.<body>``，接收方可自行复算。"""
    message = f"{timestamp}.{job_id}.".encode() + body
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def webhook_headers(
    secret: str, job_id: str, timestamp: int, body: bytes
) -> dict[str, str]:
    return {
        "content-type": "application/json",
        "X-Nexus-Lab-Job-Id": job_id,
        "X-Nexus-Lab-Timestamp": str(timestamp),
        "X-Nexus-Lab-Signature": f"sha256={sign_request(secret, job_id, timestamp, body)}",
    }


# --------------------------------------------------------------------------- #
# runner
# --------------------------------------------------------------------------- #


def _encryptor() -> Any | None:
    from agentcore.security.keys import KeyEncryptor

    if not settings.encryption_key:
        return None
    try:
        return KeyEncryptor(settings.encryption_key)
    except ValueError:
        return None


def encrypt_secret(secret: str) -> bytes:
    enc = _encryptor()
    if enc is None:
        raise RuntimeError("LAB_KEY_STORAGE_UNAVAILABLE")
    return enc.encrypt(secret.encode())


def decrypt_secret(blob: bytes) -> str | None:
    enc = _encryptor()
    if enc is None:
        return None
    try:
        return enc.decrypt(blob).decode()
    except Exception:
        return None


def due_from_job(job: LabScheduledJob) -> DueJob:
    return DueJob(
        id=job.id,
        name=job.name,
        webhook_url=job.webhook_url,
        secret_enc=job.secret_enc,
        payload_json=job.payload_json or "{}",
        interval_seconds=job.interval_seconds,
    )


async def create_job(
    session: AsyncSession,
    *,
    user_id: str,
    name: str,
    interval_seconds: int,
    webhook_url: str,
    secret: str,
    payload: dict[str, Any],
) -> LabScheduledJob:
    now = datetime.now(UTC)
    job = LabScheduledJob(
        user_id=user_id,
        name=name,
        interval_seconds=interval_seconds,
        webhook_url=webhook_url,
        secret_enc=encrypt_secret(secret),
        payload_json=json.dumps(payload, ensure_ascii=False),
        next_run_at=next_run_at(now, interval_seconds),
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)
    return job


async def list_jobs(session: AsyncSession, user_id: str) -> list[LabScheduledJob]:
    stmt = (
        select(LabScheduledJob)
        .where(LabScheduledJob.user_id == user_id)
        .order_by(LabScheduledJob.created_at.desc())
    )
    return list((await session.execute(stmt)).scalars().all())


async def get_job(
    session: AsyncSession, user_id: str, job_id: str
) -> LabScheduledJob | None:
    stmt = select(LabScheduledJob).where(
        LabScheduledJob.id == job_id, LabScheduledJob.user_id == user_id
    )
    return (await session.execute(stmt)).scalars().first()


async def delete_job(session: AsyncSession, user_id: str, job_id: str) -> bool:
    job = await get_job(session, user_id, job_id)
    if job is None:
        return False
    await session.delete(job)
    await session.commit()
    return True


async def claim_due_jobs(
    session: AsyncSession, *, now: datetime, limit: int
) -> list[DueJob]:
    """原子认领：锁行 → 先推进 next_run_at → commit → 返回纯快照。"""
    stmt = (
        select(LabScheduledJob)
        .where(
            LabScheduledJob.enabled.is_(True),
            LabScheduledJob.next_run_at <= now,
        )
        .order_by(LabScheduledJob.next_run_at)
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    rows = list((await session.execute(stmt)).scalars().all())
    snapshots = [due_from_job(job) for job in rows]
    for job in rows:
        job.next_run_at = next_run_at(now, job.interval_seconds)
    await session.commit()
    return snapshots


async def record_result(job_id: str, status: str, now: datetime) -> None:
    async with async_session_factory() as session:
        await session.execute(
            update(LabScheduledJob)
            .where(LabScheduledJob.id == job_id)
            .values(last_run_at=now, last_status=status)
        )
        await session.commit()


async def fire_job(job: DueJob, *, client: Any | None = None) -> str:
    """发一次通知，返回 ``ok`` / ``blocked`` / ``failed``（永不抛）。"""
    # 触发时再判一次 SSRF：创建后 DNS 可能改指向内网（rebinding）。
    if await classify_url(job.webhook_url) is not None:
        return "blocked"
    secret = decrypt_secret(job.secret_enc)
    if secret is None:
        return "failed"
    now = datetime.now(UTC)
    try:
        payload = json.loads(job.payload_json or "{}")
        if not isinstance(payload, dict):
            payload = {}
    except (ValueError, TypeError):
        payload = {}
    body = build_body(job.id, job.name, payload, now)
    timestamp = int(now.timestamp())
    headers = webhook_headers(secret, job.id, timestamp, body)
    timeout = settings.lab_scheduled_jobs_timeout_seconds
    try:
        if client is not None:
            response = await client.post(
                job.webhook_url, content=body, headers=headers
            )
            return "ok" if 200 <= response.status_code < 300 else "failed"
        async with outbound_async_client(timeout=timeout) as own_client:
            response = await own_client.post(
                job.webhook_url, content=body, headers=headers
            )
            return "ok" if 200 <= response.status_code < 300 else "failed"
    except Exception:
        return "failed"


async def tick(*, client: Any | None = None) -> int:
    """跑一轮；返回实际发出（含失败/被拦）的任务数。"""
    now = datetime.now(UTC)
    async with async_session_factory() as session:
        due = await claim_due_jobs(
            session,
            now=now,
            limit=settings.lab_scheduled_jobs_max_per_tick,
        )
    for job in due:
        status = await fire_job(job, client=client)
        await record_result(job.id, status, datetime.now(UTC))
    return len(due)


async def lab_scheduled_jobs_loop() -> None:
    """只在开关打开时由 lifespan 挂载；自己再守一道门，防配置热变更。"""
    if not settings.lab_scheduled_jobs_enabled:
        return
    while True:
        if not settings.lab_scheduled_jobs_enabled:
            return
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception:
            # 实验功能绝不能拖垮 lifespan；单轮失败等下一轮。
            pass
        await asyncio.sleep(max(5.0, settings.lab_scheduled_jobs_tick_seconds))
