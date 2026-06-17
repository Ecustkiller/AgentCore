"""LocalPausedTurnStore — the Sidecar's on-disk home for durably-paused turns.

The cloud persists a paused turn's frame to the ``paused_turns`` table + its
journal-so-far to ``turn_journal`` (``runtime/suspension_persistence.py``), so a
``POST .../resume`` can rebuild the turn on a fresh process. The Sidecar has **no
DB** (双模式工作区 / 远期规划 §一.1): a turn that paused at a plan_review / ask_user
checkpoint lived only on the in-proc ``InteractionRegistry`` Future, so closing the
app (or any subprocess death) lost it.

This module is the §18.6 ``Journal`` / paused-turn port's **local implementation**:
one JSON file per paused turn under a desktop-provided data dir, carrying the same
:class:`~agentcore.runtime.suspension.TurnSuspension` frame the cloud stores PLUS the
journal-so-far inline (no local ``turn_journal`` table — the file is self-contained).
The Sidecar wires :meth:`save` / :meth:`delete` as the pipeline's
``suspension_saver`` / ``suspension_deleter`` (persist before the suspend wait; drop
after a live in-process resolve), and :meth:`claim` / :meth:`list_pending` back the
``resume`` / ``listPaused`` JSON-RPC methods.

Layout is FLAT — ``<base>/<message_id>.json`` — so :meth:`delete` (which the engine
calls with only a ``message_id``) is a direct unlink; ``conversation_id`` is stored
inside and filtered in :meth:`list_pending`. A user's pending set is tiny, so the
scan is cheap. Writes are atomic (temp + ``os.replace``); a claim renames-then-reads
so a turn is never resumed twice. Every method is best-effort: a persistence failure
logs and degrades to the in-memory (process-lifetime) pause rather than breaking the
turn — same posture as the cloud saver.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
from pathlib import Path
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.suspension import TurnSuspension, suspension_from_json

logger = get_logger(__name__)


def _is_safe_message_id(message_id: str) -> bool:
    """Reject a message_id that could escape the store dir (path traversal guard).

    Ids are engine-minted tokens (``new_id()``), so this only ever rejects garbage;
    it keeps the flat-file layout safe even if a malformed id reaches the store.
    """
    if not message_id or ".." in message_id:
        return False
    return "/" not in message_id and "\\" not in message_id


class LocalPausedTurnStore:
    """A flat-file store of durably-paused Sidecar turns (one JSON file per turn)."""

    def __init__(self, base: Path) -> None:
        # ``base`` is the desktop-provided sidecar data dir (e.g.
        # ``<userData>/sidecar/paused``); created lazily on first save.
        self._base = base

    def _path(self, message_id: str) -> Path:
        return self._base / f"{message_id}.json"

    # --- engine-facing closures (suspension_saver / suspension_deleter) --------

    async def save(self, suspension: TurnSuspension) -> None:
        """Persist one paused-turn frame + its journal/history-so-far (best-effort, atomic).

        Upsert: re-pausing the same turn (resume → pause again) overwrites in place. The
        frame is ``TurnSuspension.to_json()`` (resume CONTROL metadata only — it omits the
        window-rebuild inputs by design, 执行级事件溯源 Phase 2 ⑤). The Sidecar has no DB, so
        this local file is its ENTIRE persistence: the cloud splits a pause across the
        ``turn_journal`` table (the fact stream) + the messages table (prior-turn history),
        but here BOTH ride inline —
          * ``journal_entries`` — the §18.3 fact stream the resume folds via
            ``window_from_journal`` to rebuild the CEO window (the display ``journal`` is the
            degraded fallback / resume seed);
          * ``history`` — the window's prior-turn prefix the resume splices ahead of the
            folded rounds (the journal stores only its length; the cloud reloads it from the
            message DB — the Sidecar from here).
        """
        if not _is_safe_message_id(suspension.message_id):
            return
        record = {
            "message_id": suspension.message_id,
            "conversation_id": suspension.conversation_id,
            "user_id": suspension.user_id,
            "frame": suspension.to_json(),
            "journal": list(suspension.journal),
            # The §18.3 fact stream + prior-turn history — the window-rebuild inputs the
            # cloud keeps in turn_journal + the message DB. Here they ride inline since the
            # Sidecar has no DB (this file is self-contained).
            "journal_entries": list(suspension.journal_entries),
            "history": list(suspension.history),
            # The resume-card summary (the wire shape) is computed ONCE here and stored
            # verbatim, so both the ``listPaused`` RPC and the desktop's direct file
            # read return the same shape with no re-projection drift.
            "summary": paused_summary(suspension),
            "trace_id": suspension.trace_id,
            "created_at": time.time(),
        }
        try:
            await asyncio.to_thread(self._write_sync, suspension.message_id, record)
        except Exception as e:  # noqa: BLE001 — persistence must never break the turn
            logger.warning(
                "sidecar.paused_save_failed",
                message_id=suspension.message_id,
                error=str(e),
            )

    def _write_sync(self, message_id: str, record: dict[str, Any]) -> None:
        self._base.mkdir(parents=True, exist_ok=True)
        target = self._path(message_id)
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, target)  # atomic on the same filesystem

    async def delete(self, message_id: str) -> None:
        """Drop a paused-turn frame (a live in-process resolve / timeout settled it).

        Best-effort: a stale frame left by a failed delete is harmless — the next
        ``claim`` only resurrects a turn the user can re-decide, and a re-pause
        overwrites it. NEVER raises into the turn.
        """
        if not _is_safe_message_id(message_id):
            return
        try:
            await asyncio.to_thread(self._unlink_sync, self._path(message_id))
        except Exception as e:  # noqa: BLE001 — cleanup must never break the turn
            logger.warning(
                "sidecar.paused_delete_failed", message_id=message_id, error=str(e)
            )

    @staticmethod
    def _unlink_sync(path: Path) -> None:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()

    # --- resume / listPaused backing ------------------------------------------

    async def claim(
        self, message_id: str, *, conversation_id: str | None = None
    ) -> TurnSuspension | None:
        """Atomically read-and-delete a paused turn for resume; ``None`` if gone.

        Renames the file aside FIRST (atomic ``os.replace``) so a second / racing
        resume of the same turn loses the file and gets ``None`` — a turn is never
        resumed twice. Pass ``conversation_id`` (the one the caller is scoped to) so a
        frame is only claimed within its conversation. The journal-so-far is rehydrated
        onto :attr:`TurnSuspension.journal` so the resume replays the pre-pause graph.
        """
        if not _is_safe_message_id(message_id):
            return None
        try:
            record = await asyncio.to_thread(
                self._claim_sync, message_id, conversation_id
            )
        except Exception as e:  # noqa: BLE001 — a claim failure reads as "not resumable"
            logger.warning(
                "sidecar.paused_claim_failed", message_id=message_id, error=str(e)
            )
            return None
        if record is None:
            return None
        return _suspension_from_record(record)

    def _claim_sync(
        self, message_id: str, conversation_id: str | None
    ) -> dict[str, Any] | None:
        target = self._path(message_id)
        claimed = target.with_suffix(".json.claimed")
        try:
            os.replace(target, claimed)  # atomic; raises if already claimed/absent
        except FileNotFoundError:
            return None
        try:
            record = json.loads(claimed.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            with contextlib.suppress(FileNotFoundError):
                claimed.unlink()  # torn / unreadable frame — drop it
            return None
        # Scope check while holding the claim: on a conversation mismatch RESTORE the
        # frame (claim nothing) rather than consume it — so a stray / cross-conversation
        # resume can't destroy a valid pause (IDOR-safe, like the cloud DELETE...WHERE).
        if not isinstance(record, dict) or (
            conversation_id is not None
            and record.get("conversation_id") != conversation_id
        ):
            with contextlib.suppress(OSError):
                os.replace(claimed, target)
            return None
        with contextlib.suppress(FileNotFoundError):
            claimed.unlink()
        return record

    async def list_pending(self, conversation_id: str) -> list[TurnSuspension]:
        """A conversation's pending paused turns (oldest first), rebuilt as suspensions.

        Read-only (does not claim). Best-effort: an unreadable store yields an empty
        list so reopening never fails on a paused-turn lookup.
        """
        records = await self._records(conversation_id)
        return [_suspension_from_record(r) for r in records]

    async def list_summaries(self, conversation_id: str) -> list[dict[str, Any]]:
        """A conversation's pending pauses as stored resume-card summaries (wire shape).

        The summary was projected at save time, so this reads it verbatim — no frame
        rebuild. Backs the ``listPaused`` RPC; the desktop also reads these files
        directly on reopen (no process spawn for a read-only list).
        """
        records = await self._records(conversation_id)
        return [r.get("summary") or {} for r in records]

    async def _records(self, conversation_id: str) -> list[dict[str, Any]]:
        try:
            return await asyncio.to_thread(self._list_sync, conversation_id)
        except Exception as e:  # noqa: BLE001 — a list failure degrades to "none pending"
            logger.warning(
                "sidecar.paused_list_failed",
                conversation_id=conversation_id,
                error=str(e),
            )
            return []

    def _list_sync(self, conversation_id: str) -> list[dict[str, Any]]:
        if not self._base.is_dir():
            return []
        records: list[dict[str, Any]] = []
        for path in self._base.glob("*.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue  # skip a torn / unreadable frame rather than fail the list
            if isinstance(record, dict) and record.get("conversation_id") == conversation_id:
                records.append(record)
        records.sort(key=lambda r: r.get("created_at") or 0.0)
        return records


def _suspension_from_record(record: dict[str, Any]) -> TurnSuspension:
    """Rebuild a :class:`TurnSuspension` from a stored record (frame + inline journal).

    Re-hydrates the window-rebuild inputs the frame omits (Phase 2 ⑤): ``journal_entries``
    (folded by ``window_from_journal``) and ``history`` (spliced ahead of the rounds) — the
    Sidecar's local stand-ins for the cloud's ``turn_journal`` table + message DB.
    """
    suspension = suspension_from_json(record.get("frame") or {})
    suspension.journal = list(record.get("journal") or [])
    suspension.journal_entries = list(record.get("journal_entries") or [])
    suspension.history = list(record.get("history") or [])
    return suspension


def paused_summary(suspension: TurnSuspension) -> dict[str, Any]:
    """Project a paused frame into the desktop's resume-card summary (the wire shape).

    Keys mirror the cloud ``PausedTurnSummary`` **verbatim** (snake_case) — the shared
    id/kind/context fields plus the kind-specific card content (plan_review ``steps`` /
    ``pending``; ask_user ``question`` + ``assumptions`` / ``questions`` /
    ``style_options``), unused set empty for the other kind. Same-shape-as-cloud lets the
    desktop's ``pausedTurns`` store ingest a sidecar summary with zero remapping (same
    posture as the ``runs`` payload mirroring the cloud replay schema).
    """
    return {
        "message_id": suspension.message_id,
        "kind": suspension.kind.value,
        "checkpoint_id": suspension.checkpoint_id,
        "user_message": suspension.user_message,
        "steps": getattr(suspension, "steps", []),
        "pending": getattr(suspension, "pending", []),
        "question": getattr(suspension, "question", ""),
        "context": getattr(suspension, "context", ""),
        "assumptions": getattr(suspension, "assumptions", []),
        "questions": getattr(suspension, "questions", []),
        "style_options": getattr(suspension, "style_options", []),
    }
