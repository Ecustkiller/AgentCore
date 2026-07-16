"""Process / run_process lane progressive journal persistence.

Invariant: every step visible on the live process / run_process timeline is
written to ``turn_journal`` at a semantic boundary (before the user-visible next
DURABLE, or on explicit flush) so mid-run refresh replays from journal alone.

Kinds follow ``journal.entries``: ``process_{step.kind}`` / ``run_process_{step.kind}``.
Text steps are persisted when closed; tool steps at ``tool_use_end``; markers at insert.
"""

from __future__ import annotations

import copy
from typing import Any

from agentcore.runtime.facts import Fact, record_turn_fact

# Keep in lockstep with ``journal.entries`` (avoid importing journal here — circular
# with events.sink → process_persist → journal → events).
_PROCESS_PREFIX = "process_"
_RUN_PROCESS_PREFIX = "run_process_"

# Steps that grow via delta coalesce — closed when a different kind is appended
# or on explicit flush.
_TEXT_KINDS = frozenset({"reasoning", "content"})


def process_fact_kind(step_kind: str, *, run_id: str | None = None) -> str:
    """Journal ``kind`` for one process / run_process step."""
    sk = step_kind or "step"
    if run_id:
        return f"{_RUN_PROCESS_PREFIX}{sk}"
    return f"{_PROCESS_PREFIX}{sk}"


def schedule_process_step(
    step: dict[str, Any],
    *,
    run_id: str | None = None,
) -> Any:
    """Append one closed process step to the ambient fact log + durable journal.

    Returns the writer's Future (seq barrier) or ``None`` when unbound.
    """
    payload = copy.deepcopy(step)
    if run_id:
        payload["run_id"] = run_id
    kind = process_fact_kind(str(step.get("kind") or "step"), run_id=run_id)
    return record_turn_fact(Fact(kind=kind, payload=payload))


def should_persist_on_close(step: dict[str, Any] | None) -> bool:
    """True when ``step`` is a closed text step worth journaling."""
    if not step:
        return False
    kind = step.get("kind")
    if kind not in _TEXT_KINDS:
        return False
    # Empty text steps are noise (zero-width deltas).
    text = step.get("text")
    return isinstance(text, str) and bool(text)


class ProcessPersistCursor:
    """Tracks how many captain / per-run steps have already been journaled.

    Ordinal idempotency: only steps at index ``>= persisted_count`` are written.
    Resume seeds the cursor past the inherited timeline so seeded steps are not
    rewritten.
    """

    def __init__(self) -> None:
        self.captain: int = 0
        self.runs: dict[str, int] = {}

    def seed_captain(self, count: int) -> None:
        self.captain = max(self.captain, count)

    def seed_run(self, run_id: str, count: int) -> None:
        self.runs[run_id] = max(self.runs.get(run_id, 0), count)

    def persist_captain_range(
        self,
        steps: list[dict[str, Any]],
        *,
        start: int,
        end: int,
    ) -> list[Any]:
        """Persist ``steps[start:end]`` that are not yet past the cursor."""
        futures: list[Any] = []
        for i in range(max(start, self.captain), end):
            step = steps[i]
            fut = schedule_process_step(step)
            if fut is not None:
                futures.append(fut)
            self.captain = i + 1
        return futures

    def persist_run_range(
        self,
        run_id: str,
        steps: list[dict[str, Any]],
        *,
        start: int,
        end: int,
    ) -> list[Any]:
        futures: list[Any] = []
        cursor = self.runs.get(run_id, 0)
        for i in range(max(start, cursor), end):
            step = steps[i]
            fut = schedule_process_step(step, run_id=run_id)
            if fut is not None:
                futures.append(fut)
            self.runs[run_id] = i + 1
        return futures

    def persist_new_captain_tail(self, steps: list[dict[str, Any]]) -> list[Any]:
        """Persist every captain step not yet journaled (finalize / pause flush)."""
        return self.persist_captain_range(steps, start=self.captain, end=len(steps))

    def persist_new_run_tail(self, run_id: str, steps: list[dict[str, Any]]) -> list[Any]:
        cursor = self.runs.get(run_id, 0)
        return self.persist_run_range(run_id, steps, start=cursor, end=len(steps))
