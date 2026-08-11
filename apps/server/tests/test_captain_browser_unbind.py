"""CEO captain must unbind browser sessions on exit (parity with worker executor.node).

Dogfood: conversation ed52c95d — solo browser_* without unbind stacked live:1→2→3→4
and the dock showed duplicate WorkBuddy tabs (pageId = session_id).
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any
from unittest.mock import MagicMock

import pytest

from agentcore.llm.provider.protocol import TokenUsage
from agentcore.runtime.runs.executor.captain import _drive_captain_loop
from agentcore.runtime.runs.types import RunKind, RunPhase, RunSpec
from agentcore.tools.protocol import ToolContext
from tests.llm_helpers import make_profile_params


class _FakeRegistry:
    def __init__(self) -> None:
        self.unbind_calls: list[str] = []

    def unbind_run(self, run_id: str) -> int:
        self.unbind_calls.append(run_id)
        return 1


def _spec(run_id: str = "captain-run-1") -> RunSpec:
    return RunSpec(
        run_id=run_id,
        agent_id=run_id,
        agent_name="CEO",
        kind=RunKind.CAPTAIN,
        task="open workbuddy",
        role="CEO",
        depth=0,
        parent_run_id=None,
    )


def _tool_ctx(run_id: str) -> ToolContext:
    return ToolContext(
        execution_id="exec-1",
        run_id=run_id,
        agent_id=run_id,
        backend=MagicMock(),
        user_id="u1",
        conversation_id="c1",
    )


@pytest.mark.asyncio
async def test_drive_captain_loop_unbinds_browser_run_on_success(monkeypatch: Any) -> None:
    fake = _FakeRegistry()
    monkeypatch.setattr(
        "agentcore.runtime.browser.registry.default_browser_session_registry",
        lambda: fake,
    )

    async def _fake_react_loop(**_kwargs: Any) -> tuple[str, str, TokenUsage, int]:
        return "done", "", TokenUsage(), 1

    monkeypatch.setattr(
        "agentcore.runtime.runs.executor.captain.react_loop",
        _fake_react_loop,
    )

    spec = _spec("captain-ok")
    state = await _drive_captain_loop(
        spec=spec,
        messages=[],
        received_blocks=[],
        llm=MagicMock(),
        tools=MagicMock(),
        sink=MagicMock(),
        tool_ctx=_tool_ctx(spec.run_id),
        profile=make_profile_params(),
        turn_model="test-model",
        citation_sink=[],
        approval_gate=None,
    )
    assert state.phase == RunPhase.COMPLETED
    assert fake.unbind_calls == ["captain-ok"]


@pytest.mark.asyncio
async def test_drive_captain_loop_unbinds_browser_run_on_failure(monkeypatch: Any) -> None:
    fake = _FakeRegistry()
    monkeypatch.setattr(
        "agentcore.runtime.browser.registry.default_browser_session_registry",
        lambda: fake,
    )

    async def _boom(**_kwargs: Any) -> tuple[str, str, TokenUsage, int]:
        raise RuntimeError("captain crashed")

    monkeypatch.setattr(
        "agentcore.runtime.runs.executor.captain.react_loop",
        _boom,
    )

    spec = _spec("captain-fail")
    state = await _drive_captain_loop(
        spec=spec,
        messages=[],
        received_blocks=None,
        llm=MagicMock(),
        tools=MagicMock(),
        sink=MagicMock(),
        tool_ctx=replace(_tool_ctx(spec.run_id), run_id=spec.run_id),
        profile=make_profile_params(),
        turn_model="test-model",
        citation_sink=[],
        approval_gate=None,
    )
    assert state.phase == RunPhase.FAILED
    assert fake.unbind_calls == ["captain-fail"]


@pytest.mark.asyncio
async def test_sequential_captain_runs_reuse_session_after_unbind() -> None:
    """Registry-level: captain-turn-a unbind → captain-turn-b acquire same live tab."""
    import time

    from agentcore.runtime.browser.registry import BrowserSessionRegistry
    from agentcore.tools.sandbox.browser.protocol import (
        BrowserCommand,
        BrowserCommandResult,
        BrowserSessionRequest,
    )

    class FakeBrowserSession:
        def __init__(self, conversation_id: str) -> None:
            self.conversation_id = conversation_id
            self.created_at = time.time()
            self.last_used = time.time()
            self._alive = True

        @property
        def alive(self) -> bool:
            return self._alive

        async def send(self, command: BrowserCommand) -> BrowserCommandResult:
            self.last_used = time.time()
            return BrowserCommandResult(ok=True, data={})

        async def close(self) -> None:
            self._alive = False

    created: list[FakeBrowserSession] = []

    async def factory(request: BrowserSessionRequest) -> FakeBrowserSession:
        s = FakeBrowserSession(request.conversation_id)
        created.append(s)
        return s

    reg = BrowserSessionRegistry(factory=factory, max_sessions=8)
    s1, _ = await reg.acquire(
        BrowserSessionRequest(conversation_id="c1", run_id="captain-turn-1")
    )
    assert len(created) == 1
    assert reg.unbind_run("captain-turn-1") == 1

    s2, _ = await reg.acquire(
        BrowserSessionRequest(conversation_id="c1", run_id="captain-turn-2")
    )
    assert s2 is s1
    assert len(created) == 1
