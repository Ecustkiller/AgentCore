"""EventSink — async queue bridging execution and SSE delivery."""

from __future__ import annotations

import asyncio
from typing import Any

from agentcore.runtime.facts import Fact, record_turn_fact
from agentcore.runtime.events.journal_config import (
    _HISTORY_COALESCE_RUN,
    _HISTORY_COALESCE_TURN,
    _HISTORY_SKIP_TYPES,
    _JOURNAL_EVENT_TYPES,
    _JOURNAL_SURFACE_TYPES,
    _PROCESS_RESULT_CAP,
)
from agentcore.runtime.events.types import EventType, SSEEvent


class EventSink:
    """Async queue bridging execution (producer) and SSE (consumer)."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[SSEEvent | None] = asyncio.Queue()
        self._closed = False
        self._detached = False
        self._history: list[SSEEvent] = []
        self._journal: list[dict[str, Any]] = []
        self._process: list[dict[str, Any]] = []
        self._has_run_plan = False
        self._has_tool = False

    def emit(self, event: SSEEvent) -> None:
        if not self._closed:
            if event.type in _JOURNAL_EVENT_TYPES:
                self._journal.append(
                    {
                        "type": event.type.value,
                        "payload": event.payload,
                        "timestamp": event.timestamp,
                    }
                )
                record_turn_fact(
                    Fact(
                        kind=event.type.value,
                        payload=event.payload,
                        ts=event.timestamp,
                    )
                )
            self._accumulate_process(event)
            self._record_history(event)
            if not self._detached:
                self._queue.put_nowait(event)

    def _record_history(self, event: SSEEvent) -> None:
        t = event.type
        if t in _HISTORY_SKIP_TYPES:
            return
        if t in _HISTORY_COALESCE_TURN:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            last = self._history[-1] if self._history else None
            if last is not None and last.type == t:
                last.payload["delta"] = (last.payload.get("delta") or "") + delta
            else:
                self._history.append(
                    SSEEvent(type=t, payload={"delta": delta}, timestamp=event.timestamp)
                )
            return
        if t in _HISTORY_COALESCE_RUN:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            run_id = event.payload.get("run_id")
            last = self._history[-1] if self._history else None
            if (
                last is not None
                and last.type == t
                and last.payload.get("run_id") == run_id
            ):
                last.payload["delta"] = (last.payload.get("delta") or "") + delta
            else:
                self._history.append(
                    SSEEvent(type=t, payload=dict(event.payload), timestamp=event.timestamp)
                )
            return
        if t == EventType.TOOL_USE_END:
            payload = dict(event.payload)
            result = payload.get("result")
            if isinstance(result, str) and len(result) > _PROCESS_RESULT_CAP:
                payload["result"] = result[:_PROCESS_RESULT_CAP] + "…"
            self._history.append(
                SSEEvent(type=t, payload=payload, timestamp=event.timestamp)
            )
            return
        self._history.append(
            SSEEvent(type=t, payload=event.payload, timestamp=event.timestamp)
        )

    def detach(self) -> None:
        self._detached = True

    def take_over(self) -> list[SSEEvent]:
        while True:
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        snapshot = list(self._history)
        if self._closed:
            self._queue.put_nowait(None)
        else:
            self._detached = False
        return snapshot

    def _accumulate_process(self, event: SSEEvent) -> None:
        t = event.type
        if t == EventType.RUN_PLAN:
            self._has_run_plan = True
        elif t == EventType.REASONING_DELTA:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            if self._process and self._process[-1].get("kind") == "reasoning":
                self._process[-1]["text"] += delta
            else:
                self._process.append({"kind": "reasoning", "text": delta})
        elif t == EventType.CONTENT_DELTA:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            if self._process and self._process[-1].get("kind") == "content":
                self._process[-1]["text"] += delta
            else:
                self._process.append({"kind": "content", "text": delta})
        elif t == EventType.CONTENT_RESET:
            while self._process and self._process[-1].get("kind") == "content":
                self._process.pop()
        elif t == EventType.TOOL_USE_START:
            self._has_tool = True
            payload = event.payload
            if payload.get("run_id"):
                return
            self._process.append(
                {
                    "kind": "tool",
                    "id": payload.get("tool_call_id", ""),
                    "tool_name": payload.get("tool_name", ""),
                    "arguments": payload.get("arguments") or {},
                    "result": None,
                    "status": "running",
                }
            )
        elif t == EventType.TOOL_USE_END:
            payload = event.payload
            if payload.get("run_id"):
                return
            call_id = payload.get("tool_call_id", "")
            result = payload.get("result")
            if isinstance(result, str) and len(result) > _PROCESS_RESULT_CAP:
                result = result[:_PROCESS_RESULT_CAP] + "…"
            display = payload.get("display")
            for step in reversed(self._process):
                if step.get("kind") == "tool" and step.get("id") == call_id:
                    step["result"] = result
                    step["status"] = payload.get("status", "success")
                    if display is not None:
                        step["display"] = display
                    break

    def seed_journal(self, events: list[dict[str, Any]]) -> None:
        self._journal.extend(events)

    def execution_journal(self) -> list[dict[str, Any]] | None:
        has_surface = any(
            e["type"] in _JOURNAL_SURFACE_TYPES for e in self._journal
        )
        return self._journal if has_surface else None

    def process_timeline(self) -> list[dict[str, Any]] | None:
        if not self._has_tool:
            return None
        return self._process or None

    def captain_context(self) -> list[dict[str, Any]] | None:
        from agentcore.runtime.runs.types import RunKind

        captain_run_id: str | None = None
        for e in self._journal:
            payload = e.get("payload") or {}
            if (
                e.get("type") == EventType.RUN_STARTED.value
                and payload.get("kind") == RunKind.CAPTAIN.value
            ):
                captain_run_id = payload.get("run_id")
                break
        if captain_run_id is None:
            return None
        found = False
        blocks: list[dict[str, Any]] = []
        for e in self._journal:
            payload = e.get("payload") or {}
            if (
                e.get("type") == EventType.RUN_CONTEXT.value
                and payload.get("run_id") == captain_run_id
            ):
                found = True
                blocks.extend(payload.get("blocks") or [])
        return blocks if found else None

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._queue.put_nowait(None)

    async def get(self) -> SSEEvent | None:
        return await self._queue.get()

    async def __aiter__(self):
        while True:
            event = await self._queue.get()
            if event is None:
                return
            yield event
