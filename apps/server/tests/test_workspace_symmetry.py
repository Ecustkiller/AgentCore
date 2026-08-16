"""Tests for LocalWorkspace subpath scoping (工作区对称化 D1a).

When bound to a sub-directory under a shared container root, every op path is
prefixed on the way to the desktop and stripped on the way back, so the
engine/tools/user only see workspace-relative paths. Unscoped (``base=""``) is a
pure pass-through (regression guard for root-bound local projects).
"""

import asyncio

import pytest

from agentcore.runtime.events import EventSink
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.tools.sandbox.protocol import ExecutionRequest
from agentcore.workspace.channel import WorkspaceChannel
from agentcore.workspace.local import LocalWorkspace
from agentcore.workspace.protocol import GrepQuery
from tests.client_tool_fulfill_testutil import await_captured_event

pytestmark = pytest.mark.anyio

CONV = "conv-1"
ROOT_ID = "root-abc"


def _make(base: str = "") -> tuple[LocalWorkspace, InteractionRegistry, EventSink]:
    sink = EventSink()
    registry = InteractionRegistry()
    channel = WorkspaceChannel(
        user_id="u-test",
        conversation_id=CONV,
        registry=registry,
        timeout_seconds=5.0,
        root_id=ROOT_ID,
    )
    return LocalWorkspace(channel, base_subpath=base), registry, sink


async def _await_request():
    """Return the CLIENT_TOOL event just delivered via fulfill."""
    return await await_captured_event()


async def _round_trip(coro, sink, registry, response: dict):
    task = asyncio.create_task(coro)
    event = await _await_request()
    assert registry.resolve(event.payload["request_id"], response, conversation_id=CONV)
    return await task, event


async def test_scoped_read_prefixes_subpath():
    local, registry, sink = _make(base="proj")
    _, event = await _round_trip(local.read("a.txt"), sink, registry, {"ok": True, "value": "hi"})
    assert event.payload["args"]["path"] == "proj/a.txt"


async def test_scoped_write_and_move_prefix_paths():
    local, registry, sink = _make(base="proj")
    _, ew = await _round_trip(
        local.write("out.txt", "data"), sink, registry, {"ok": True, "value": 4}
    )
    assert ew.payload["args"]["path"] == "proj/out.txt"
    _, em = await _round_trip(
        local.move("a.txt", "b.txt"), sink, registry, {"ok": True, "value": None}
    )
    assert em.payload["args"] == {"src": "proj/a.txt", "dst": "proj/b.txt"}


async def test_scoped_list_prefixes_dir_and_strips_results():
    local, registry, sink = _make(base="proj")
    response = {
        "ok": True,
        "value": [
            {"path": "proj/src", "is_dir": True},
            {"path": "proj/src/main.py", "is_dir": False},
        ],
    }
    entries, event = await _round_trip(local.list(".", "*"), sink, registry, response)
    assert event.payload["args"]["directory"] == "proj"
    assert [(e.path, e.is_dir) for e in entries] == [
        ("src", True),
        ("src/main.py", False),
    ]


async def test_scoped_index_files_sends_base_and_strips():
    local, registry, sink = _make(base="proj")
    response = {
        "ok": True,
        "value": {"paths": ["proj/a.txt", "proj/sub/b.md"], "truncated": False},
    }
    (paths, _), event = await _round_trip(local.index_files(), sink, registry, response)
    assert event.payload["args"]["base"] == "proj"
    assert paths == ["a.txt", "sub/b.md"]


async def test_scoped_grep_prefixes_dir_and_strips_hits():
    local, registry, sink = _make(base="proj")
    response = {
        "ok": True,
        "value": {
            "hits": [{"path": "proj/a.py", "line_no": 3, "text": "x"}],
            "file_counts": [["proj/a.py", 1]],
            "total_matches": 1,
            "truncated": False,
        },
    }
    result, event = await _round_trip(local.grep(GrepQuery(pattern="x")), sink, registry, response)
    assert event.payload["args"]["directory"] == "proj"
    assert result.hits[0].path == "a.py"
    assert result.file_counts == [("a.py", 1)]


async def test_scoped_execute_sends_cwd_subpath():
    local, registry, sink = _make(base="proj")
    response = {
        "ok": True,
        "value": {
            "success": True,
            "stdout": "",
            "stderr": "",
            "exit_code": 0,
            "duration_ms": 1,
        },
    }
    _, event = await _round_trip(
        local.execute(ExecutionRequest(code="print(1)", language="python")),
        sink,
        registry,
        response,
    )
    assert event.payload["args"]["cwd"] == "proj"


def _exec_value(**extra) -> dict:
    return {
        "ok": True,
        "value": {
            "success": True,
            "stdout": "ok",
            "stderr": "",
            "exit_code": 0,
            "duration_ms": 1,
            **extra,
        },
    }


async def _execute_past_probe(local, registry, response: dict):
    """Drive ``execute`` through its single CLIENT_TOOL round-trip."""
    task = asyncio.create_task(
        local.execute(ExecutionRequest(code="print(1)", language="python"))
    )
    event = await _await_request()
    assert registry.resolve(
        event.payload["request_id"], response, conversation_id=CONV
    )
    return await task


async def test_scoped_execute_strips_subpath_from_written_files():
    """产物写回: 本机执行报的落盘路径同样要剥掉 D1a 前缀（与 list / grep 同约定）。

    桌面按绑定根相对回报（它只认根），工作区相对是本侧的事——不剥，交付物台账里就会出现
    一条模型和用户都打不开的 ``proj/…`` 路径。
    """
    local, registry, _sink = _make(base="proj")
    result = await _execute_past_probe(
        local,
        registry,
        _exec_value(written_files=["proj/report.md", "proj/out/chart.png"]),
    )
    assert result.written_files == ["report.md", "out/chart.png"]


async def test_execute_without_written_files_stays_unmeasured():
    """旧桌面不报这个字段 → ``None``（「没测量」不许伪装成「测了没变化」）。"""
    local, registry, _sink = _make()
    result = await _execute_past_probe(local, registry, _exec_value())
    assert result.written_files is None


async def test_scoped_exists_git_prefixes_subpath():
    """G2: ``exists(".git")`` probes project subdir, not the shared container root."""
    local, registry, sink = _make(base="projA")
    assert local.base_subpath == "projA"
    _, event = await _round_trip(
        local.exists(".git"), sink, registry, {"ok": True, "value": False}
    )
    assert event.payload["args"]["path"] == "projA/.git"


async def test_unscoped_is_pure_passthrough():
    """base="" → no prefix / no strip (existing root-bound local projects unchanged)."""
    local, registry, sink = _make()
    _, read_ev = await _round_trip(local.read("a.txt"), sink, registry, {"ok": True, "value": "x"})
    assert read_ev.payload["args"]["path"] == "a.txt"
    response = {"ok": True, "value": {"paths": ["a.txt", "sub/b.md"], "truncated": False}}
    (paths, _), idx_ev = await _round_trip(local.index_files(), sink, registry, response)
    assert idx_ev.payload["args"]["base"] == "."
    assert paths == ["a.txt", "sub/b.md"]
