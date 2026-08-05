"""LocalRunSessionStore — Sidecar on-disk home for the 留人 roster.

The cloud persists recoverable worker sessions to ``run_sessions`` via
``runtime/session_persistence.py``. The Sidecar has **no telemetry DB**
(双模式工作区 §十), so a memory-roster LRU eviction was a hard miss and the
engine still claimed「落盘均未命中」even though no loader was wired.

This module is the local durable backend: one JSON file per ``run_id`` under
a desktop-provided data dir. Sidecar wires :meth:`save` / :meth:`load` as the
pipeline's ``session_saver`` / ``session_loader`` (same closures the cloud's
``turn_runner.session_callbacks`` injects).
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.runs.serialize import session_from_row, session_to_row
from agentcore.runtime.runs.session import RunSession

logger = get_logger(__name__)


def _is_safe_run_id(run_id: str) -> bool:
    """Reject a run_id that could escape the store dir (path traversal guard)."""
    if not run_id or ".." in run_id:
        return False
    return "/" not in run_id and "\\" not in run_id


class LocalRunSessionStore:
    """Flat-file durable roster for Sidecar (one JSON file per run_id)."""

    def __init__(self, base: Path) -> None:
        self._base = base

    def _path(self, run_id: str) -> Path:
        return self._base / f"{run_id}.json"

    async def save(self, conversation_id: str, session: RunSession) -> None:
        """Write-through persist one recoverable session (best-effort)."""
        if not _is_safe_run_id(session.run_id):
            logger.warning(
                "sidecar.run_session_persist_skipped",
                run_id=session.run_id,
                reason="unsafe_run_id",
            )
            return
        payload: dict[str, Any] = {
            "conversation_id": conversation_id,
            **session_to_row(session),
        }
        path = self._path(session.run_id)

        def _write() -> None:
            self._base.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(tmp, path)

        try:
            await asyncio.to_thread(_write)
        except Exception as e:  # noqa: BLE001 — persistence must never break the turn
            logger.warning(
                "sidecar.run_session_persist_failed",
                run_id=session.run_id,
                error=str(e),
            )

    async def load(self, run_id: str) -> RunSession | None:
        """Rehydrate a persisted session by ``run_id``; ``None`` on miss / error."""
        key = (run_id or "").strip()
        if not _is_safe_run_id(key):
            return None
        path = self._path(key)

        def _read() -> dict[str, Any] | None:
            if not path.is_file():
                return None
            return json.loads(path.read_text(encoding="utf-8"))

        try:
            raw = await asyncio.to_thread(_read)
        except Exception as e:  # noqa: BLE001 — load failure degrades to roster miss
            logger.warning("sidecar.run_session_load_failed", run_id=key, error=str(e))
            return None
        if not isinstance(raw, dict):
            return None
        try:
            return session_from_row(SimpleNamespace(**raw))
        except Exception as e:  # noqa: BLE001
            logger.warning("sidecar.run_session_load_failed", run_id=key, error=str(e))
            return None
