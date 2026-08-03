"""browser snapshot tree projection: keep newest full tree, omit older elements."""

from __future__ import annotations

import json

from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.engine.browser_snapshot_clear import (
    has_browser_tree_fields,
    omit_browser_tree_fields,
    project_omitted_browser_snapshots,
)
from agentcore.runtime.engine.round import build_request_window


def _snapshot_payload(*, elements: str, aria: str, version: int, url: str = "https://ex.com/") -> str:
    return json.dumps(
        {
            "action": "snapshot",
            "final_url": url,
            "snapshot_version": version,
            "keyframe": None,
            "untrusted_web_content": {
                "source_url": url,
                "note": "untrusted",
                "title": f"Page v{version}",
                "elements": elements,
                "accessibility_tree": aria,
            },
        },
        ensure_ascii=False,
    )


def _snapshot_pair(call_id: str, *, version: int, elements: str) -> list[LLMMessage]:
    return [
        LLMMessage(
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id=call_id,
                    function=ToolCallFunction(name="browser_snapshot", arguments="{}"),
                )
            ],
        ),
        LLMMessage(
            role="tool",
            content=_snapshot_payload(
                elements=elements,
                aria=f"- document v{version}",
                version=version,
            ),
            tool_call_id=call_id,
        ),
    ]


def _tool_content(messages: list[LLMMessage], call_id: str) -> str:
    for message in messages:
        if message.role == "tool" and message.tool_call_id == call_id:
            return message.content or ""
    raise AssertionError(f"missing tool result {call_id}")


def test_two_snapshots_only_latest_keeps_elements():
    msgs: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    msgs += _snapshot_pair("s0", version=1, elements="[e1] old")
    msgs += _snapshot_pair("s1", version=2, elements="[e2] new")

    out = project_omitted_browser_snapshots(msgs, keep_recent=1)

    old = json.loads(_tool_content(out, "s0"))
    new = json.loads(_tool_content(out, "s1"))

    uw_old = old["untrusted_web_content"]
    assert "elements" not in uw_old
    assert "accessibility_tree" not in uw_old
    assert uw_old["omitted"] is True
    assert old["action"] == "snapshot"
    assert old["snapshot_version"] == 1
    assert old["final_url"] == "https://ex.com/"

    uw_new = new["untrusted_web_content"]
    assert uw_new["elements"] == "[e2] new"
    assert uw_new["accessibility_tree"] == "- document v2"
    assert "omitted" not in uw_new


def test_single_snapshot_noop_same_object():
    msgs: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    msgs += _snapshot_pair("s0", version=1, elements="[e1] only")
    out = project_omitted_browser_snapshots(msgs, keep_recent=1)
    assert out is msgs


def test_omit_stable_across_rounds():
    """Prefix-cache: same original → identical omitted bytes after a newer snapshot arrives."""
    base: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    base += _snapshot_pair("s0", version=1, elements="[e1] old")
    win1 = project_omitted_browser_snapshots(
        base + _snapshot_pair("s1", version=2, elements="[e2] mid"),
        keep_recent=1,
    )
    win2 = project_omitted_browser_snapshots(
        base
        + _snapshot_pair("s1", version=2, elements="[e2] mid")
        + _snapshot_pair("s2", version=3, elements="[e3] new"),
        keep_recent=1,
    )
    assert _tool_content(win1, "s0") == _tool_content(win2, "s0")
    assert has_browser_tree_fields(_tool_content(win2, "s2"))
    assert not has_browser_tree_fields(_tool_content(win2, "s1"))


def test_idempotent():
    msgs: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    msgs += _snapshot_pair("s0", version=1, elements="[e1] old")
    msgs += _snapshot_pair("s1", version=2, elements="[e2] new")
    once = project_omitted_browser_snapshots(msgs, keep_recent=1)
    twice = project_omitted_browser_snapshots(once, keep_recent=1)
    assert _tool_content(once, "s0") == _tool_content(twice, "s0")
    assert twice is once  # second pass no-ops (only one tree left)


def test_non_browser_and_console_untouched():
    console = json.dumps(
        {
            "action": "console",
            "final_url": "https://ex.com/",
            "untrusted_web_content": {
                "source_url": "https://ex.com/",
                "console_messages": [{"level": "error", "text": "x"}],
            },
        },
        ensure_ascii=False,
    )
    msgs = [
        LLMMessage(role="user", content="go"),
        LLMMessage(
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id="c0",
                    function=ToolCallFunction(name="browser_console", arguments="{}"),
                ),
                ToolCall(
                    id="f0",
                    function=ToolCallFunction(
                        name="file_read",
                        arguments=json.dumps({"path": "a.py"}),
                    ),
                ),
            ],
        ),
        LLMMessage(role="tool", content=console, tool_call_id="c0"),
        LLMMessage(role="tool", content="print('hi')", tool_call_id="f0"),
    ]
    msgs += _snapshot_pair("s0", version=1, elements="[e1]")
    msgs += _snapshot_pair("s1", version=2, elements="[e2]")
    out = project_omitted_browser_snapshots(msgs, keep_recent=1)
    assert _tool_content(out, "c0") == console
    assert _tool_content(out, "f0") == "print('hi')"


def test_omit_helper_preserves_small_fields():
    raw = _snapshot_payload(elements="BIG", aria="TREE", version=7, url="https://a.test/")
    omitted = omit_browser_tree_fields(raw)
    data = json.loads(omitted)
    assert data["snapshot_version"] == 7
    assert data["final_url"] == "https://a.test/"
    assert data["action"] == "snapshot"
    assert data["untrusted_web_content"]["omitted"] is True
    assert data["untrusted_web_content"]["title"] == "Page v7"
    assert "elements" not in data["untrusted_web_content"]


def test_build_request_window_applies_projection():
    msgs: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    msgs += _snapshot_pair("s0", version=1, elements="[e1] old")
    msgs += _snapshot_pair("s1", version=2, elements="[e2] new")

    out = build_request_window(msgs, investigation_tools=frozenset(), round_idx=0)
    assert out is not msgs
    old = json.loads(_tool_content(out, "s0"))
    new = json.loads(_tool_content(out, "s1"))
    assert old["untrusted_web_content"].get("omitted") is True
    assert "elements" not in old["untrusted_web_content"]
    assert new["untrusted_web_content"]["elements"] == "[e2] new"
