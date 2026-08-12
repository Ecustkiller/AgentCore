"""Unit tests for local MCP Client channel + dynamic worker tools."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from agentcore.core.types import ToolApproval
from agentcore.desktop.channel import DesktopClientChannel, McpOp, McpOpError
from agentcore.runtime.events.client_tool_reattach import (
    CHANNEL_MCP,
    build_client_tool_required,
    client_tool_payload,
)
from agentcore.runtime.events.types import EventType
from agentcore.runtime.interaction import InteractionKind, InteractionRequest
from agentcore.tools.builtin import build_ceo_tool_registry, build_worker_registry
from agentcore.tools.mcp.dynamic import McpDynamicTool, sanitize_mcp_tool_name
from agentcore.tools.mcp.wire import (
    McpDiscoverResult,
    McpToolSpec,
    clear_mcp_discover_cache,
    discover_mcp_tools,
    mcp_capability_label,
    parse_mcp_list_payload,
    register_mcp_tools,
    seed_mcp_discover_cache,
)
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry


@pytest.fixture(autouse=True)
def _isolate_mcp_discover_cache():
    clear_mcp_discover_cache()
    yield
    clear_mcp_discover_cache()


def test_sanitize_mcp_tool_name_stable_and_bounded():
    name = sanitize_mcp_tool_name("my-server!", "list/files")
    assert name.startswith("mcp_")
    assert len(name) <= 64
    assert "/" not in name
    assert "!" not in name


def test_mcp_capability_label_matrix():
    assert mcp_capability_label(None, desktop_online=False) == "未装配"
    assert mcp_capability_label(None, desktop_online=True) == "未装配"
    ready = McpDiscoverResult(tool_count=2, ready_servers=1)
    assert mcp_capability_label(ready, desktop_online=True) == "已装配"
    degraded = McpDiscoverResult(degraded=True, failed_servers=1)
    assert mcp_capability_label(degraded, desktop_online=True) == "降级（无可用工具）"


def test_register_mcp_tools_worker_only_grantable():
    registry = ToolRegistry()
    result = McpDiscoverResult(
        ready_servers=1,
        tool_count=1,
        specs=(
            McpToolSpec(
                server_id="echo",
                server_name="Echo",
                mcp_tool_name="ping",
                description="Ping",
                input_schema={"type": "object", "properties": {}},
            ),
        ),
    )
    assert register_mcp_tools(registry, result) == 1
    tool = registry.get("mcp_echo_ping")
    assert tool.schema.approval is ToolApproval.GRANTABLE
    assert "MCP" in tool.schema.description


def test_desktop_touch_tool_names_cover_mcp_and_host():
    from agentcore.runtime.sandbox_approval import is_desktop_touch_tool

    assert is_desktop_touch_tool("mcp_echo_ping")
    assert is_desktop_touch_tool("host_shell")
    assert not is_desktop_touch_tool("file_write")
    assert not is_desktop_touch_tool("web_search")


def test_resolve_worker_gate_shares_gate_for_mcp_on_cloud():
    from types import SimpleNamespace

    from agentcore.runtime.delegate.drive_setup import resolve_worker_gate
    from agentcore.tools.mcp.dynamic import McpDynamicTool

    registry = ToolRegistry()
    registry.register(
        McpDynamicTool(
            fc_name="mcp_echo_ping",
            server_id="echo",
            server_name="Echo",
            mcp_tool_name="ping",
            description="Ping",
            input_schema=None,
        )
    )
    gate = object()
    backend = SimpleNamespace(location="server")
    tool = SimpleNamespace(
        _approval_gate=gate,
        _tools=registry,
        _base_tool_context=SimpleNamespace(backend=backend),
    )
    assert resolve_worker_gate(tool) is gate

    empty = ToolRegistry()
    tool_no_mcp = SimpleNamespace(
        _approval_gate=gate,
        _tools=empty,
        _base_tool_context=SimpleNamespace(backend=backend),
    )
    assert resolve_worker_gate(tool_no_mcp) is None


def test_ceo_registry_has_no_mcp_tools_by_default():
    ceo = {s.name for s in build_ceo_tool_registry(desktop_online=True).list_all()}
    worker = build_worker_registry(desktop_online=True)
    register_mcp_tools(
        worker,
        McpDiscoverResult(
            tool_count=1,
            specs=(
                McpToolSpec(
                    server_id="s",
                    server_name="S",
                    mcp_tool_name="t",
                    description="d",
                    input_schema=None,
                ),
            ),
        ),
    )
    worker_names = {s.name for s in worker.list_all()}
    assert "mcp_s_t" in worker_names
    assert not any(n.startswith("mcp_") for n in ceo)


@pytest.mark.asyncio
async def test_discover_mcp_tools_degrades_without_channel():
    result = await discover_mcp_tools(None)
    assert result.tool_count == 0
    assert result.detail == "no_desktop_channel"


@pytest.mark.asyncio
async def test_discover_mcp_tools_parses_ready_and_failed():
    channel = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="c1",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    channel.request_mcp = AsyncMock(  # type: ignore[method-assign]
        return_value={
            "servers": [
                {
                    "id": "ok",
                    "name": "OK",
                    "status": "ready",
                    "tools": [
                        {
                            "name": "echo",
                            "description": "Echo",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"text": {"type": "string"}},
                            },
                        }
                    ],
                },
                {
                    "id": "bad",
                    "name": "Bad",
                    "status": "failed",
                    "error": "spawn failed",
                    "tools": [],
                },
            ]
        }
    )
    result = await discover_mcp_tools(channel)
    assert result.ready_servers == 1
    assert result.failed_servers == 1
    assert result.tool_count == 1
    assert result.specs[0].mcp_tool_name == "echo"
    channel.request_mcp.assert_awaited_once()
    assert channel.request_mcp.await_args.kwargs.get("timeout") == 1.0


@pytest.mark.asyncio
async def test_discover_mcp_tools_cache_hit_skips_request():
    channel = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="c-cache",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    channel.request_mcp = AsyncMock(  # type: ignore[method-assign]
        return_value={
            "servers": [
                {
                    "id": "ok",
                    "name": "OK",
                    "status": "ready",
                    "tools": [{"name": "echo", "description": "Echo"}],
                }
            ]
        }
    )
    first = await discover_mcp_tools(channel)
    second = await discover_mcp_tools(channel)
    assert first.tool_count == 1
    assert second.tool_count == 1
    assert second.specs == first.specs
    channel.request_mcp.assert_awaited_once()
    assert channel.request_mcp.await_args.kwargs.get("timeout") == 1.0


@pytest.mark.asyncio
async def test_discover_mcp_tools_cache_only_miss_skips_channel(monkeypatch):
    """prepare-path: cache miss must not await ClientTool / request_mcp."""
    events: list[tuple[str, dict]] = []

    def _capture(event: str, **kwargs):
        events.append((event, kwargs))

    monkeypatch.setattr("agentcore.tools.mcp.wire.logger.info", _capture)
    channel = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="c-cache-only-miss",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    channel.request_mcp = AsyncMock(  # type: ignore[method-assign]
        return_value={"servers": []}
    )
    result = await discover_mcp_tools(channel, cache_scope="user-1", cache_only=True)
    assert result.tool_count == 0
    assert result.detail == "cache_miss"
    assert not result.degraded
    channel.request_mcp.assert_not_awaited()
    miss = [e for e in events if e[0] == "desktop.mcp_list_cache_miss"]
    assert len(miss) == 1
    assert miss[0][1]["detail"] == "cache_miss"
    assert miss[0][1]["conversation_id"] == "c-cache-only-miss"
    assert miss[0][1]["cache_scope"] == "user-1"
    assert mcp_capability_label(result, desktop_online=True) == "未装配"


@pytest.mark.asyncio
async def test_seed_then_cache_only_prepare_path_hits():
    """Non-turn seed → prepare-style cache_only discover hits without network."""
    payload = {
        "servers": [
            {
                "id": "ok",
                "name": "OK",
                "status": "ready",
                "tools": [{"name": "echo", "description": "Echo"}],
            }
        ]
    }
    seeded = parse_mcp_list_payload(payload)
    assert seeded.tool_count == 1
    seed_mcp_discover_cache("conv-seed", seeded, cache_scope="user-seed")

    channel = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="conv-seed",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    channel.request_mcp = AsyncMock(  # type: ignore[method-assign]
        side_effect=AssertionError("cache_only must not call request_mcp")
    )
    result = await discover_mcp_tools(
        channel, cache_scope="user-seed", cache_only=True
    )
    assert result.tool_count == 1
    assert result.specs == seeded.specs
    channel.request_mcp.assert_not_awaited()

    # Same user, new conversation → scope hit still works under cache_only.
    other = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="conv-other",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    other.request_mcp = AsyncMock(  # type: ignore[method-assign]
        side_effect=AssertionError("cache_only must not call request_mcp")
    )
    scoped = await discover_mcp_tools(
        other, cache_scope="user-seed", cache_only=True
    )
    assert scoped.tool_count == 1
    other.request_mcp.assert_not_awaited()


@pytest.mark.asyncio
async def test_discover_mcp_tools_cache_scope_hits_across_conversations():
    """Same user (cache_scope) + new conversation_id → shared cache hit."""
    payload = {
        "servers": [
            {
                "id": "ok",
                "name": "OK",
                "status": "ready",
                "tools": [{"name": "echo", "description": "Echo"}],
            }
        ]
    }
    c1 = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="conv-a",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    c1.request_mcp = AsyncMock(return_value=payload)  # type: ignore[method-assign]
    c2 = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="conv-b",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    c2.request_mcp = AsyncMock(return_value=payload)  # type: ignore[method-assign]

    first = await discover_mcp_tools(c1, cache_scope="user-1")
    second = await discover_mcp_tools(c2, cache_scope="user-1")
    assert first.tool_count == 1
    assert second.tool_count == 1
    assert second.specs == first.specs
    c1.request_mcp.assert_awaited_once()
    c2.request_mcp.assert_not_awaited()


@pytest.mark.asyncio
async def test_discover_mcp_tools_cache_scope_isolated_per_user():
    """Different cache_scope must not share — no cross-tenant hit."""
    payload = {
        "servers": [
            {
                "id": "ok",
                "name": "OK",
                "status": "ready",
                "tools": [{"name": "echo", "description": "Echo"}],
            }
        ]
    }
    c1 = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="conv-a",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    c1.request_mcp = AsyncMock(return_value=payload)  # type: ignore[method-assign]
    c2 = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="conv-b",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    c2.request_mcp = AsyncMock(return_value=payload)  # type: ignore[method-assign]

    await discover_mcp_tools(c1, cache_scope="user-1")
    await discover_mcp_tools(c2, cache_scope="user-2")
    c1.request_mcp.assert_awaited_once()
    c2.request_mcp.assert_awaited_once()


@pytest.mark.asyncio
async def test_discover_mcp_tools_degrades_on_timeout():
    channel = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="c1",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    channel.request_mcp = AsyncMock(  # type: ignore[method-assign]
        side_effect=McpOpError("timeout")
    )
    result = await discover_mcp_tools(channel)
    assert result.degraded
    assert result.tool_count == 0
    channel.request_mcp.assert_awaited_once()
    assert channel.request_mcp.await_args.kwargs.get("timeout") == 1.0


@pytest.mark.asyncio
async def test_discover_mcp_tools_negative_cache_skips_request():
    channel = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="c-neg",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    channel.request_mcp = AsyncMock(  # type: ignore[method-assign]
        side_effect=McpOpError("timeout")
    )
    first = await discover_mcp_tools(channel)
    second = await discover_mcp_tools(channel)
    assert first.degraded
    assert second.degraded
    assert second.detail == first.detail
    channel.request_mcp.assert_awaited_once()
    assert channel.request_mcp.await_args.kwargs.get("timeout") == 1.0


@pytest.mark.asyncio
async def test_discover_mcp_tools_ok_logs_duration_and_tool_count(monkeypatch):
    events: list[tuple[str, dict]] = []

    def _capture(event: str, **kwargs):
        events.append((event, kwargs))

    monkeypatch.setattr(
        "agentcore.tools.mcp.wire.logger.info",
        _capture,
    )
    channel = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="c-ok-log",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    channel.request_mcp = AsyncMock(  # type: ignore[method-assign]
        return_value={
            "servers": [
                {
                    "id": "ok",
                    "name": "OK",
                    "status": "ready",
                    "tools": [{"name": "echo", "description": "Echo"}],
                }
            ]
        }
    )
    result = await discover_mcp_tools(channel)
    assert result.tool_count == 1
    ok_events = [e for e in events if e[0] == "desktop.mcp_list_ok"]
    assert len(ok_events) == 1
    assert ok_events[0][1]["tool_count"] == 1
    assert isinstance(ok_events[0][1]["duration_ms"], int)
    assert ok_events[0][1]["duration_ms"] >= 0


@pytest.mark.asyncio
async def test_discover_mcp_tools_degraded_logs_duration(monkeypatch):
    events: list[tuple[str, dict]] = []

    def _capture(event: str, **kwargs):
        events.append((event, kwargs))

    monkeypatch.setattr(
        "agentcore.tools.mcp.wire.logger.info",
        _capture,
    )
    channel = DesktopClientChannel(
        sink=AsyncMock(),
        conversation_id="c-deg-log",
        registry=AsyncMock(),
        timeout_seconds=5,
    )
    channel.request_mcp = AsyncMock(  # type: ignore[method-assign]
        side_effect=McpOpError("timeout")
    )
    result = await discover_mcp_tools(channel)
    assert result.degraded
    deg = [e for e in events if e[0] == "desktop.mcp_list_degraded"]
    assert len(deg) == 1
    assert isinstance(deg[0][1]["duration_ms"], int)
    assert deg[0][1]["duration_ms"] >= 0
    assert deg[0][1]["tool_count"] == 0


@pytest.mark.asyncio
async def test_request_mcp_emits_mcp_op_required():
    emitted: list[Any] = []

    class _Sink:
        def emit(self, event: Any) -> None:
            emitted.append(event)

    async def _suspend(*_a, **kwargs):
        on_suspended = kwargs.get("on_suspended")
        if callable(on_suspended):
            on_suspended()
        return {"ok": True, "value": {"servers": []}}

    registry = AsyncMock()
    registry.suspend = AsyncMock(side_effect=_suspend)
    channel = DesktopClientChannel(
        sink=_Sink(),  # type: ignore[arg-type]
        conversation_id="c1",
        registry=registry,
        timeout_seconds=5,
    )
    value = await channel.request_mcp(McpOp.LIST_TOOLS, {})
    assert value == {"servers": []}
    assert len(emitted) == 1
    assert emitted[0].type.value == "mcp_op_required"
    assert emitted[0].payload["op"] == "list_tools"


@pytest.mark.asyncio
async def test_mcp_dynamic_tool_call_and_no_channel():
    from unittest.mock import MagicMock

    tool = McpDynamicTool(
        fc_name="mcp_s_echo",
        server_id="s",
        server_name="S",
        mcp_tool_name="echo",
        description="Echo",
        input_schema={"type": "object", "properties": {"text": {"type": "string"}}},
    )
    ctx = ToolContext.create(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=MagicMock(location="server"),
        user_id="u1",
        desktop_channel=None,
    )
    miss = await tool.execute({"text": "hi"}, ctx)
    assert not miss.success
    assert "桌面" in (miss.error or "")

    channel = AsyncMock()
    channel.request_mcp = AsyncMock(return_value={"content": "hi", "isError": False})
    ctx2 = ToolContext.create(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=MagicMock(location="server"),
        user_id="u1",
        desktop_channel=channel,
    )
    ok = await tool.execute({"text": "hi"}, ctx2)
    assert ok.success
    assert ok.output == "hi"
    channel.request_mcp.assert_awaited_once()


def test_mcp_reattach_rebuilds_required_event():
    import asyncio

    loop = asyncio.new_event_loop()
    try:
        req = InteractionRequest(
            id="rid",
            kind=InteractionKind.CLIENT_TOOL,
            conversation_id="c1",
            future=loop.create_future(),
            payload=client_tool_payload(
                CHANNEL_MCP,
                EventType.MCP_OP_REQUIRED.value,
                params={"op": "call_tool", "args": {"server_id": "s", "tool_name": "t"}},
            ),
        )
        event = build_client_tool_required(req)
        assert event is not None
        assert event.type.value == "mcp_op_required"
        assert event.payload["op"] == "call_tool"
    finally:
        loop.close()
