"""Schema + mapping + logging for ``RecordTurnRequest.tool_failures``."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from agentcore.api.schemas.messages import (
    LocalTurnToolFailure,
    RecordTurnRequest,
    normalize_local_turn_tool_failure_code,
    truncate_tool_failure_message,
)
from agentcore.conversation import local_turn as local_turn_mod
from agentcore.conversation.service import record_local_turn
from agentcore.conversation.store.outbox import (
    to_record_turn_body,
    tool_failures_from_journal,
)

pytestmark = pytest.mark.anyio

_TRACE = "0123456789abcdef0123456789abcdef"


@pytest.mark.parametrize(
    ("message", "code", "expected"),
    [
        ("searxng healthz failed", None, "searxng_unreachable"),
        ("搜索服务 searxng.local 最近连续多次请求失败（超时或连接失败）", None, "searxng_unreachable"),
        ("搜索失败：无法建立连接（出网受限或站点不可达）", None, "egress_connect"),
        ("ConnectError: connection refused", None, "egress_connect"),
        ("连接超时（无法连上该站点）", None, "egress_connect"),
        ("缺少必填参数：query", None, "other"),
        ("anything", "searxng_unreachable", "searxng_unreachable"),
        ("searxng down", "egress_connect", "egress_connect"),
        ("unknown", "weird", "other"),
    ],
)
def test_normalize_local_turn_tool_failure_code(message, code, expected):
    assert normalize_local_turn_tool_failure_code(message, code=code) == expected


def test_truncate_tool_failure_message_caps_at_200():
    long = "x" * 250
    assert len(truncate_tool_failure_message(long)) == 200
    assert truncate_tool_failure_message(None) == ""


def test_local_turn_tool_failure_schema_normalizes_and_truncates():
    long = "无法建立连接：" + ("y" * 250)
    row = LocalTurnToolFailure(tool="web_search", code="weird", message=long)
    assert row.code == "egress_connect"
    assert len(row.message) == 200


def test_record_turn_request_accepts_empty_user_message():
    """Process-only salvage may omit real um (ffafc42b)."""
    body = RecordTurnRequest(
        user_message="",
        user_message_id="u1",
        trace_id=_TRACE,
    )
    assert body.user_message == ""


def test_record_turn_request_tool_failures_optional_default_empty():
    body = RecordTurnRequest(
        user_message="hi",
        user_message_id="u1",
        trace_id=_TRACE,
    )
    assert body.tool_failures == []


def test_record_turn_request_accepts_tool_failures():
    body = RecordTurnRequest(
        user_message="hi",
        user_message_id="u1",
        trace_id=_TRACE,
        tool_failures=[
            {
                "tool": "web_search",
                "code": "searxng_unreachable",
                "message": "searxng unreachable",
            }
        ],
    )
    assert len(body.tool_failures) == 1
    assert body.tool_failures[0].tool == "web_search"
    assert body.tool_failures[0].code == "searxng_unreachable"


def test_record_turn_request_rejects_empty_tool_name():
    with pytest.raises(ValidationError):
        RecordTurnRequest(
            user_message="hi",
            user_message_id="u1",
            trace_id=_TRACE,
            tool_failures=[{"tool": "", "code": "other", "message": "x"}],
        )


def test_tool_failures_from_journal_prefers_tool_call_facts():
    entries = [
        {
            "kind": "tool_call",
            "payload": {
                "name": "web_search",
                "success": False,
                "result": "搜索失败：无法建立连接（出网受限或站点不可达）",
            },
        },
        {
            "kind": "tool_use_end",
            "payload": {
                "tool_name": "web_search",
                "status": "error",
                "result": "duplicate display end",
            },
        },
        {
            "kind": "tool_call",
            "payload": {"name": "read_url", "success": True, "result": "ok"},
        },
    ]
    failures = tool_failures_from_journal(entries)
    assert len(failures) == 1
    assert failures[0]["tool"] == "web_search"
    assert failures[0]["code"] == "egress_connect"


def test_tool_failures_from_journal_falls_back_to_tool_use_end():
    entries = [
        {
            "kind": "tool_use_end",
            "payload": {
                "tool_name": "web_search",
                "status": "error",
                "result": "searxng unreachable",
            },
        }
    ]
    failures = tool_failures_from_journal(entries)
    assert failures == [
        {
            "tool": "web_search",
            "code": "searxng_unreachable",
            "message": "searxng unreachable",
        }
    ]


def test_to_record_turn_body_includes_tool_failures_from_journal():
    body = to_record_turn_body(
        {
            "user_message_id": "u1",
            "user_message": "hi",
            "trace_id": _TRACE,
            "journal": {
                "1": {
                    "kind": "tool_call",
                    "payload": {
                        "name": "web_search",
                        "success": False,
                        "result": "搜索服务 down",
                    },
                    "ts": "t1",
                }
            },
        }
    )
    assert body["tool_failures"] == [
        {
            "tool": "web_search",
            "code": "searxng_unreachable",
            "message": "搜索服务 down",
        }
    ]


def test_to_record_turn_body_omits_tool_failures_when_none():
    body = to_record_turn_body(
        {
            "user_message_id": "u1",
            "user_message": "hi",
            "trace_id": _TRACE,
            "journal": {
                "0": {
                    "kind": "tool_call",
                    "payload": {"name": "web_search", "success": True, "result": "ok"},
                }
            },
        }
    )
    assert "tool_failures" not in body


async def test_record_local_turn_logs_tool_failures(monkeypatch):
    logged: list[tuple] = []

    class _Logger:
        def info(self, event, **kwargs):
            logged.append((event, kwargs))

    monkeypatch.setattr(local_turn_mod, "logger", _Logger())
    finalize = AsyncMock(
        return_value={
            "user_message_id": "u1",
            "assistant_message_id": "a1",
            "title": None,
            "followups": None,
            "noop": False,
        }
    )
    monkeypatch.setattr(
        local_turn_mod,
        "get_cloud_store",
        lambda: type("S", (), {"finalize": finalize})(),
    )

    await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="ok",
        user_message_id="u1",
        message_id="m1",
        trace_id=_TRACE,
        tool_failures=[
            {"tool": "web_search", "code": "searxng_unreachable", "message": "down"},
            {"tool": "read_url", "code": "egress_connect", "message": "connect"},
        ],
    )

    assert logged == [
        (
            "chat.local_turn_tool_failures",
            {
                "conversation_id": "c1",
                "message_id": "m1",
                "count": 2,
                "codes": ["searxng_unreachable", "egress_connect"],
            },
        )
    ]
    finalize.assert_awaited_once()
    assert "tool_failures" not in finalize.await_args.kwargs


async def test_record_local_turn_skips_log_when_no_failures(monkeypatch):
    logged: list[tuple] = []

    class _Logger:
        def info(self, event, **kwargs):
            logged.append((event, kwargs))

    monkeypatch.setattr(local_turn_mod, "logger", _Logger())
    finalize = AsyncMock(
        return_value={
            "user_message_id": "u1",
            "assistant_message_id": "a1",
            "title": None,
            "followups": None,
            "noop": False,
        }
    )
    monkeypatch.setattr(
        local_turn_mod,
        "get_cloud_store",
        lambda: type("S", (), {"finalize": finalize})(),
    )

    await record_local_turn(
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="ok",
        user_message_id="u1",
        message_id="m1",
        trace_id=_TRACE,
    )

    assert logged == []
