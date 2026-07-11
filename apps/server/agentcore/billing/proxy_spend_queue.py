"""At-least-once durable queue for inference ``proxy_spend`` ledger writes.

Request path only enqueues (disk + wake); a background drain writes to
``cost_events`` via the **telemetry** pool so spend never contends with
content-write connections (as-built: 成本配额 §三).

Idempotency: each record carries a stable ``run_id``; ``CostEventRepository``
uses ``ON CONFLICT (run_id) DO NOTHING``, so drain retries never double-bill.

Deployment constraint (single-process):
    Queue files live under ``{data_dir}/telemetry/proxy_spend_queue/``.
    **Before multi-worker / multi-instance deployment, migrate this queue to
    Redis or a DB outbox** — a process-local disk queue would otherwise drop
    or double-consume across workers.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from agentcore.config import settings
from agentcore.core.log_context import log_context
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.llm.provider.protocol import TokenUsage

logger = get_logger(__name__)

_QUEUE_SUBDIR = Path("telemetry") / "proxy_spend_queue"
_DRAIN_IDLE_WAIT_S = 0.05
_DRAIN_RETRY_BACKOFF_S = 0.05


def _queue_dir() -> Path:
    return Path(settings.data_dir) / _QUEUE_SUBDIR


def _record_path(record_id: str) -> Path:
    return _queue_dir() / f"{record_id}.json"


class ProxySpendQueue:
    """Process-local durable queue + single drain consumer."""

    def __init__(self) -> None:
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._stopping = False

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def enqueue(
        self,
        *,
        user_id: str,
        conversation_id: str,
        model: str,
        usage: TokenUsage,
        trace_id: str | None = None,
        message_id: str | None = None,
    ) -> str | None:
        """Persist one spend record to disk and wake the drain. Returns record id.

        Builds the priced ``RunCost`` (stable ``run_id``) *before* the disk write so
        retries reuse the same idempotency key. Returns ``None`` when there is no
        conversation (cannot satisfy ``cost_events.conversation_id NOT NULL``).
        """
        if not conversation_id:
            logger.warning(
                "inference.proxy_spend_no_conversation",
                user_id=user_id,
                model=model,
            )
            return None

        from agentcore.runtime.costing import ROLE_CAPTAIN, background_run_cost

        run = background_run_cost(ROLE_CAPTAIN, model or "", usage)
        record_id = new_id()
        payload: dict[str, Any] = {
            "id": record_id,
            "user_id": user_id,
            "conversation_id": conversation_id,
            "message_id": message_id,
            "trace_id": trace_id,
            "runs": [asdict(run)],
            "enqueued_at": datetime.now(UTC).isoformat(),
        }
        path = _record_path(record_id)
        tmp = path.with_suffix(".tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as e:
            # Disk enqueue failed — do not raise into the already-streamed response,
            # but surface loudly (no silent swallow). The spend is lost for this call.
            logger.error(
                "inference.proxy_spend_enqueue_failed",
                user_id=user_id,
                conversation_id=conversation_id,
                error=str(e),
            )
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                logger.error(
                    "inference.proxy_spend_enqueue_tmp_cleanup_failed",
                    path=str(tmp),
                )
            return None

        logger.info(
            "inference.proxy_spend_enqueued",
            record_id=record_id,
            run_id=run.run_id,
            conversation_id=conversation_id,
        )
        self._wake.set()
        return record_id

    def start(self) -> None:
        """Start the background drain (idempotent). Call from app lifespan."""
        if self.running:
            return
        self._stopping = False
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.error("inference.proxy_spend_drainer_no_loop")
            return
        self._task = loop.create_task(self._drain_loop(), name="proxy_spend_drain")
        self._wake.set()  # pick up any leftover files from a prior process exit
        logger.info("inference.proxy_spend_drainer_started", queue_dir=str(_queue_dir()))

    async def stop(self) -> None:
        """Drain remaining files once, then cancel the loop (app shutdown)."""
        self._stopping = True
        self._wake.set()
        if self._task is None:
            await self.drain_once()
            return
        try:
            await self.drain_once()
        finally:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
            logger.info("inference.proxy_spend_drainer_stopped")

    async def drain_once(self) -> int:
        """Process every pending file once. Returns successful write count.

        Failed writes leave the file in place for the next attempt (at-least-once).
        """
        directory = _queue_dir()
        if not directory.exists():
            return 0
        written = 0
        for path in sorted(directory.glob("*.json")):
            ok = await self._drain_file(path)
            if ok:
                written += 1
        return written

    async def _drain_loop(self) -> None:
        while not self._stopping:
            try:
                written = await self.drain_once()
            except Exception:  # noqa: BLE001 — loop must survive; next wake retries
                logger.exception("inference.proxy_spend_drain_loop_error")
                written = 0
            if written == 0:
                self._wake.clear()
                # Re-check for a race: enqueue between drain_once and clear.
                if any(_queue_dir().glob("*.json")) if _queue_dir().exists() else False:
                    continue
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=_DRAIN_IDLE_WAIT_S)
                except TimeoutError:
                    # Periodic poll so files dropped by a crashed prior process
                    # (or a wake lost before start) are still picked up.
                    continue
            else:
                # Yield so other tasks run; immediate re-scan if more arrived.
                await asyncio.sleep(0)

    async def _drain_file(self, path: Path) -> bool:
        try:
            raw = path.read_text(encoding="utf-8")
            payload = json.loads(raw)
        except (OSError, json.JSONDecodeError) as e:
            logger.error(
                "inference.proxy_spend_record_corrupt",
                path=str(path),
                error=str(e),
            )
            # Move aside so a poison file cannot block the queue forever.
            poison = path.with_suffix(".corrupt")
            try:
                os.replace(path, poison)
            except OSError:
                logger.error(
                    "inference.proxy_spend_corrupt_quarantine_failed",
                    path=str(path),
                )
            return False

        user_id = payload.get("user_id")
        conversation_id = payload.get("conversation_id")
        runs = payload.get("runs") or []
        if not user_id or not conversation_id or not runs:
            logger.error(
                "inference.proxy_spend_record_invalid",
                path=str(path),
                record_id=payload.get("id"),
            )
            poison = path.with_suffix(".corrupt")
            try:
                os.replace(path, poison)
            except OSError:
                logger.error(
                    "inference.proxy_spend_corrupt_quarantine_failed",
                    path=str(path),
                )
            return False

        trace_id = payload.get("trace_id")
        message_id = payload.get("message_id")
        with log_context(trace_id=trace_id, conversation_id=conversation_id):
            try:
                from agentcore.db.base import telemetry_session_factory
                from agentcore.db.repositories import CostEventRepository

                async with telemetry_session_factory() as session:
                    await CostEventRepository(session).record_runs(
                        user_id=user_id,
                        conversation_id=conversation_id,
                        message_id=message_id,
                        runs=runs,
                        trace_id=trace_id,
                    )
            except Exception as e:
                logger.warning(
                    "inference.proxy_spend_failed",
                    user_id=user_id,
                    conversation_id=conversation_id,
                    record_id=payload.get("id"),
                    run_id=(runs[0] or {}).get("run_id") if runs else None,
                    error=str(e),
                )
                await asyncio.sleep(_DRAIN_RETRY_BACKOFF_S)
                return False

        try:
            path.unlink(missing_ok=True)
        except OSError as e:
            # DB write succeeded; file delete failed. Next drain will re-insert
            # and hit run_id ON CONFLICT DO NOTHING — no double billing, but
            # surface the leak so ops can clean the stuck file.
            logger.error(
                "inference.proxy_spend_ack_failed",
                path=str(path),
                record_id=payload.get("id"),
                error=str(e),
            )
            return True

        logger.info(
            "inference.proxy_spend_drained",
            record_id=payload.get("id"),
            run_id=(runs[0] or {}).get("run_id") if runs else None,
            conversation_id=conversation_id,
        )
        return True


_default_queue: ProxySpendQueue | None = None


def get_proxy_spend_queue() -> ProxySpendQueue:
    """Process-wide queue singleton (created lazily)."""
    global _default_queue
    if _default_queue is None:
        _default_queue = ProxySpendQueue()
    return _default_queue


def reset_proxy_spend_queue_for_tests() -> ProxySpendQueue:
    """Replace the singleton (tests only)."""
    global _default_queue
    _default_queue = ProxySpendQueue()
    return _default_queue
