"""回合内工具结果清理 (clear_tool_uses): pure-function + loop-integration tests.

The projection ``project_cleared_window`` collapses OLD re-fetchable read-only tool
results to a compact stable pointer in the model-facing window, while the canonical
``messages`` list keeps the full output (so resume / journal are byte-identical). These
tests pin: what gets cleared vs kept, the prefix-cache invariants (stable + monotonic
+ structure-preserving + idempotent), and the wiring into ``react_loop``.
"""

import json
from pathlib import Path

from agentcore.config import settings
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.config import ModelProfile
from agentcore.llm.protocol import LLMChunk, LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.engine import react_loop
from agentcore.runtime.engine.tool_clear import cleared_placeholder, project_cleared_window
from agentcore.runtime.events import EventSink
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

CLEARABLE = frozenset({"file_read", "grep", "web_search"})


def _read_pair(call_id: str, path: str, result: str, *, tool: str = "file_read") -> list[LLMMessage]:
    """An assistant tool-call round + its tool result, as the loop accumulates them."""
    return [
        LLMMessage(
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id=call_id,
                    function=ToolCallFunction(name=tool, arguments=json.dumps({"path": path})),
                )
            ],
        ),
        LLMMessage(role="tool", content=result, tool_call_id=call_id),
    ]


def _window(n_pairs: int, *, size: int = 200, tool: str = "file_read") -> list[LLMMessage]:
    msgs: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    for i in range(n_pairs):
        msgs += _read_pair(f"c{i}", f"src/f{i}.py", "X" * size, tool=tool)
    return msgs


def _cleared_ids(messages: list[LLMMessage]) -> list[str]:
    return [
        m.tool_call_id
        for m in messages
        if m.role == "tool" and (m.content or "").startswith("[已清理")
    ]


# ── pure function ───────────────────────────────────────────────────────────


def test_keeps_recent_clears_old():
    msgs = _window(8)  # 8 big read results
    out = project_cleared_window(msgs, clearable_tools=CLEARABLE, keep_recent=2, min_chars=100)
    # First 6 cleared, last 2 (c6, c7) kept verbatim.
    assert _cleared_ids(out) == [f"c{i}" for i in range(6)]
    kept = [m for m in out if m.role == "tool" and not (m.content or "").startswith("[已清理")]
    assert [m.tool_call_id for m in kept] == ["c6", "c7"]
    assert all(len(m.content or "") == 200 for m in kept)


def test_small_results_not_cleared():
    msgs = _window(8, size=50)  # every result < min_chars
    out = project_cleared_window(msgs, clearable_tools=CLEARABLE, keep_recent=2, min_chars=100)
    assert out is msgs  # no-op → same object


def test_non_investigation_tool_not_cleared():
    msgs = _window(8, tool="code_execute")  # not in clearable set
    out = project_cleared_window(msgs, clearable_tools=CLEARABLE, keep_recent=2, min_chars=100)
    assert out is msgs


def test_injected_user_and_assistant_untouched():
    msgs = _window(4)
    msgs.append(LLMMessage(role="user", content="[系统提示] 复盘一下进度。"))  # a nudge/reflection
    out = project_cleared_window(msgs, clearable_tools=CLEARABLE, keep_recent=1, min_chars=100)
    # the injected user steer and all assistant messages survive verbatim
    assert any(m.role == "user" and m.content == "[系统提示] 复盘一下进度。" for m in out)
    assert all(o.content == n.content for o, n in zip(msgs, out, strict=True) if o.role == "assistant")


def test_structure_preserved_no_orphans():
    msgs = _window(8)
    out = project_cleared_window(msgs, clearable_tools=CLEARABLE, keep_recent=2, min_chars=100)
    # every tool message still pairs with an assistant tool_call of the same id
    issued = {
        c.id for m in out if m.role == "assistant" and m.tool_calls for c in m.tool_calls
    }
    tool_ids = [m.tool_call_id for m in out if m.role == "tool"]
    assert len(tool_ids) == 8  # none dropped
    assert all(tid in issued for tid in tool_ids)  # no orphan tool message


def test_placeholder_stable_and_monotonic():
    # Same cleared result yields byte-identical pointer across two successive rounds
    # (prefix-cache invariant), and clearing only grows (monotonic).
    win_k = project_cleared_window(_window(5), clearable_tools=CLEARABLE, keep_recent=2, min_chars=10)
    win_k1 = project_cleared_window(_window(6), clearable_tools=CLEARABLE, keep_recent=2, min_chars=10)

    def cleared_content(window: list[LLMMessage], call_id: str) -> str | None:
        for m in window:
            if m.role == "tool" and m.tool_call_id == call_id:
                return m.content
        return None

    # c0 is cleared in both; its pointer bytes must be identical.
    assert cleared_content(win_k, "c0").startswith("[已清理")
    assert cleared_content(win_k, "c0") == cleared_content(win_k1, "c0")
    # monotonic: everything cleared at round K is still cleared at round K+1.
    assert set(_cleared_ids(win_k)).issubset(set(_cleared_ids(win_k1)))


def test_idempotent():
    msgs = _window(8)
    once = project_cleared_window(msgs, clearable_tools=CLEARABLE, keep_recent=2, min_chars=100)
    twice = project_cleared_window(once, clearable_tools=CLEARABLE, keep_recent=2, min_chars=100)
    assert [m.content for m in twice] == [m.content for m in once]


def test_placeholder_names_the_call():
    ph = cleared_placeholder("file_read", json.dumps({"path": "src/foo.py"}), 8421)
    assert "file_read" in ph and "src/foo.py" in ph and "8421" in ph
    # deterministic
    assert ph == cleared_placeholder("file_read", json.dumps({"path": "src/foo.py"}), 8421)


def test_empty_clearable_is_noop():
    msgs = _window(8)
    assert project_cleared_window(msgs, clearable_tools=frozenset(), keep_recent=2, min_chars=100) is msgs


# ── loop wiring ─────────────────────────────────────────────────────────────


class _FakeReadTool:
    """A read-only NEVER-approval FILESYSTEM tool so the loop classifies it as an
    investigation tool (clearable). Never executed by these tests (the window is
    pre-seeded and the provider finishes round 0)."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_read",
            description="read a file",
            parameters={"type": "object", "properties": {"path": {"type": "string"}}},
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments, context) -> ToolResult:  # noqa: ANN001 - duck-typed
        return ToolResult(tool_call_id="", success=True, output="unused")


class _CapturingProvider:
    """Records the request window each round, then yields scripted chunks."""

    def __init__(self, rounds: list[list[LLMChunk]]) -> None:
        self._rounds = rounds
        self.calls = 0
        self.windows: list[list[LLMMessage]] = []

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        self.windows.append(list(request.messages))
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else []
        self.calls += 1
        for chunk in chunks:
            yield chunk


def _context() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


async def _run_loop(provider: _CapturingProvider) -> None:
    registry = ToolRegistry()
    registry.register(_FakeReadTool())
    messages = _window(8)  # pre-seeded prior reads
    profile = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=4)
    await react_loop(
        messages=messages,
        llm=provider,
        tools=registry,
        sink=EventSink(),
        tool_context=_context(),
        profile=profile,
    )


async def test_loop_clears_old_reads_in_request_window(monkeypatch):
    monkeypatch.setattr(settings, "engine_tool_clear_keep_recent", 2)
    monkeypatch.setattr(settings, "engine_tool_clear_min_chars", 100)
    provider = _CapturingProvider([[LLMChunk(delta_content="调查完成，结论如下。")]])
    await _run_loop(provider)
    window = provider.windows[0]
    # 6 old read results cleared, 2 most-recent kept full — the canonical messages
    # the loop holds are untouched (only the request view is projected).
    assert len(_cleared_ids(window)) == 6
    kept = [m for m in window if m.role == "tool" and not (m.content or "").startswith("[已清理")]
    assert len(kept) == 2 and all(len(m.content or "") == 200 for m in kept)


async def test_loop_no_clear_when_keep_recent_high(monkeypatch):
    monkeypatch.setattr(settings, "engine_tool_clear_keep_recent", 100)  # effectively off
    monkeypatch.setattr(settings, "engine_tool_clear_min_chars", 100)
    provider = _CapturingProvider([[LLMChunk(delta_content="调查完成。")]])
    await _run_loop(provider)
    window = provider.windows[0]
    assert _cleared_ids(window) == []  # nothing cleared
    assert all(len(m.content or "") == 200 for m in window if m.role == "tool")
