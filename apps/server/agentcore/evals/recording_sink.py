"""EventSink hook that records tool calls and delegation roster for assertions."""

from __future__ import annotations

import json

from agentcore.runtime.events import EventSink, EventType, SSEEvent


class RecordingSink(EventSink):
    """在现有 :class:`EventSink` 上挂钩，捕获过程事实供断言（其余照常入 journal/queue）.

    - ``tool_calls``：从 ``tool_use_start`` 取 ``(name, args_json)``，按发生顺序；
    - ``roster``：从 ``run_plan`` 的 ``agents[*].role`` 取委派计划期的**语义角色**（去重、保序）。
      不取 ``run_completed.role``——那是成本台账类目（member/captain），非语义角色；也不取
      ``run_started``（其载荷无 role）。
    """

    def __init__(self) -> None:
        super().__init__()
        self.tool_calls: list[tuple[str, str]] = []
        self.roster: list[str] = []

    def emit(self, event: SSEEvent) -> None:
        if event.type == EventType.TOOL_USE_START:
            self._record_tool_call(event.payload)
        elif event.type == EventType.RUN_PLAN:
            self._record_roster(event.payload)
        super().emit(event)

    def _record_tool_call(self, payload: dict) -> None:
        name = payload.get("tool_name", "")
        args = payload.get("arguments")
        if isinstance(args, str):
            args_json = args
        else:
            try:
                args_json = json.dumps(args or {}, ensure_ascii=False, sort_keys=True)
            except (TypeError, ValueError):
                args_json = "{}"
        self.tool_calls.append((name, args_json))

    def _record_roster(self, payload: dict) -> None:
        for agent in payload.get("agents", []) or []:
            role = (agent or {}).get("role")
            if role and role not in self.roster:
                self.roster.append(role)
