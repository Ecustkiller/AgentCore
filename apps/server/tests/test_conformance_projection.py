"""Independent guard for the ProjectedTurn oracle (手机端落地设计 §六 支柱1).

The `pnpm conformance` gate proves "mobile fold == oracle golden"; this proves the
oracle itself is correct with HAND-VERIFIED expectations, so a correlated bug (oracle
and a fold making the same mistake) can't pass both. Runs the full export pipeline
(vector → serialize → project), the exact bytes the golden is written from.
"""

from __future__ import annotations

import pytest

from agentcore.conformance.export import build_fixtures


@pytest.fixture(scope="module")
def projected() -> dict[str, dict]:
    return {fx["name"]: fx["projected"] for fx in build_fixtures()}


def test_single_agent_text(projected):
    p = projected["single_agent_text"]
    assert p["status"] == "completed"
    assert p["finishReason"] == "end_turn"
    assert p["content"] == "你好，世界！"
    assert p["reasoning"] == "先想一下。好的。"
    assert p["process"] == [
        {"kind": "reasoning", "text": "先想一下。好的。"},
        {"kind": "content", "text": "你好，世界！"},
    ]
    assert p["runs"] == []
    assert p["agents"] == []
    assert p["progress"] == {"completed": 0, "total": 0}
    assert p["pendingInteraction"] is None
    assert p["cost"]["total"] == 360_000


def test_single_agent_tool_timeline(projected):
    p = projected["single_agent_tool"]
    assert [s["kind"] for s in p["process"]] == ["reasoning", "tool", "content"]
    tool = p["process"][1]
    assert tool["id"] == "tc1"
    assert tool["tool_name"] == "web_search"
    assert tool["status"] == "success"
    assert tool["result"] == "找到 3 条结果。"
    # No display in the vector → the key is omitted (not display=None), so both ends
    # agree by absence.
    assert "display" not in tool
    assert p["content"] == "根据搜索，答案如下。"


def test_single_agent_error(projected):
    p = projected["single_agent_error"]
    assert p["status"] == "failed"
    assert p["finishReason"] is None
    assert p["content"] == "开始处理"
    assert p["cost"] is None


def test_multi_agent_delegate_tree(projected):
    p = projected["multi_agent_delegate"]
    assert p["status"] == "completed"
    # Multi-agent: the team graph carries activity; the single-agent process is empty.
    assert p["process"] == []
    assert p["content"] == "我来安排团队。 团队已完成。"
    assert len(p["runs"]) == 2
    assert all(r["status"] == "completed" for r in p["runs"])
    assert p["progress"] == {"completed": 2, "total": 2}
    assert p["agents"][0]["id"] == "w1"
    assert p["agents"][0]["status"] == "completed"
    assert p["agents"][0]["output"] == "调研结论"
    # usage/cost ride verbatim from run_completed.
    assert p["runs"][0]["cost"]["total"] == 360_000
    assert p["runs"][0]["usage"]["input"] == 1200


def test_approval_paused(projected):
    p = projected["approval_paused"]
    assert p["status"] == "paused"
    assert p["finishReason"] is None
    assert p["pendingInteraction"] == {
        "kind": "approval",
        "approvalId": "tc1",
        "toolCallId": "tc1",
        "toolName": "code_execute",
        "arguments": {"code": "print(1)"},
    }


def test_approval_resolved_clears_pending(projected):
    p = projected["approval_resolved_continue"]
    assert p["status"] == "completed"
    assert p["pendingInteraction"] is None
    assert p["content"] == "我需要运行代码。运行结果是 1。"


def test_plan_review_paused(projected):
    p = projected["plan_review_paused"]
    assert p["status"] == "paused"
    assert p["pendingInteraction"] == {
        "kind": "plan_review",
        "checkpointId": "cp1",
        "runIds": ["r1"],
    }
    assert p["runs"][0]["checkpoint"] == {"status": "pending", "decision": None}
    assert p["progress"] == {"completed": 1, "total": 2}


def test_plan_review_resolved_runs_downstream(projected):
    p = projected["plan_review_resolved_continue"]
    assert p["status"] == "completed"
    assert p["pendingInteraction"] is None
    assert p["runs"][0]["checkpoint"] == {"status": "resolved", "decision": "continue"}
    assert p["progress"] == {"completed": 2, "total": 2}


def test_single_agent_citations(projected):
    p = projected["single_agent_citations"]
    assert p["status"] == "completed"
    assert [s["kind"] for s in p["process"]] == ["reasoning", "tool", "content"]
    # citations ride verbatim (full {url,title,snippet,site} dicts), in order.
    assert [c["url"] for c in p["citations"]] == [
        "https://a.example/x",
        "https://b.example/y",
    ]
    assert p["citations"][0] == {
        "url": "https://a.example/x",
        "title": "来源 A",
        "snippet": "片段 A",
        "site": "a.example",
    }


def test_multi_agent_worker_tool(projected):
    p = projected["multi_agent_worker_tool"]
    # No message_end → still running; w2 frozen mid-compose so its toolProgress shows.
    assert p["status"] == "running"
    assert p["finishReason"] is None
    assert p["process"] == []  # worker tool_use never leaks into the single-agent lane
    w1 = next(a for a in p["agents"] if a["id"] == "w1")
    w2 = next(a for a in p["agents"] if a["id"] == "w2")
    assert w1["status"] == "completed"
    assert w1["toolProgress"] is None  # cleared by run_completed
    assert w2["status"] == "working"
    assert w2["toolProgress"] == {"toolName": "code_execute", "chars": 64}
    assert p["progress"] == {"completed": 1, "total": 2}


def test_multi_agent_debate_tags(projected):
    p = projected["multi_agent_debate"]
    assert p["status"] == "completed"
    r1 = next(r for r in p["runs"] if r["id"] == "r1")
    r2 = next(r for r in p["runs"] if r["id"] == "r2")
    assert (r1["stance"], r1["group"], r1["round"]) == ("pro", "g1", 1)
    assert (r2["stance"], r2["group"], r2["round"]) == ("con", "g1", 1)


def test_multi_agent_revision_synthesizes_node(projected):
    p = projected["multi_agent_revision"]
    assert p["status"] == "completed"
    # A revision is born from its run_started frame (not the plan): a new agent cloned
    # from the original's identity + a 修订 node hung off the original.
    assert [a["id"] for a in p["agents"]] == ["w1", "w1b"]
    w1b = next(a for a in p["agents"] if a["id"] == "w1b")
    assert w1b["role"] == "撰写员"  # inherited from the original agent
    assert w1b["output"] == "修订稿"
    rev = next(r for r in p["runs"] if r["id"] == "r1v2")
    assert rev["revisionOf"] == "r1"
    assert rev["revision"] == 2
    assert rev["parentRunId"] == "r1"
    assert rev["task"] == "起草"  # inherited from the original run
    assert p["progress"] == {"completed": 2, "total": 2}


def test_multi_agent_multi_batch_merges(projected):
    p = projected["multi_agent_multi_batch"]
    assert p["status"] == "completed"
    # Second delegate batch (same execution_id) merges into the live graph; progress is
    # cumulative across both batches (derived from run states, not run_progress).
    assert [a["id"] for a in p["agents"]] == ["w1", "w2"]
    assert [r["id"] for r in p["runs"]] == ["r1", "r2"]
    assert all(r["status"] == "completed" for r in p["runs"])
    assert p["progress"] == {"completed": 2, "total": 2}
    assert p["content"] == "先调研。 再撰写。"
