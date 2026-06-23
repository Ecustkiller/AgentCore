"""Independent guard for the ProjectedTurn oracle (前端技术与架构 §十二).

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
    # 统一团队时间线: the captain's OWN inline timeline rides `process` (content + a `team`
    # marker fixing where the collaboration graph slots in — the orchestration call itself
    # makes NO tool step). Worker outputs ride `runs`/`agents`, not this lane.
    assert [s["kind"] for s in p["process"]] == ["content", "team", "content"]
    assert [s["execution_id"] for s in p["process"] if s["kind"] == "team"] == ["exec1"]
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
    # 统一团队时间线 (worker-tool 归属修): a delegated worker's tool_use carries run_id, so the
    # process folds keep it OUT of the captain bubble — `process` is the CEO's own intro
    # content plus the `team` marker (dropped at run_plan) fixing the graph's slot. The
    # worker's tool rides the team graph (toolProgress, asserted below), never the CEO timeline.
    assert p["process"] == [
        {"kind": "content", "text": "我来分工。"},
        {"kind": "team", "execution_id": "exec1"},
    ]
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
    # 主持人作为完成态节点 + 2 辩手 → 进度 3/3（CEO 不进图，是主气泡）。
    assert p["progress"] == {"completed": 3, "total": 3}
    mod = next(r for r in p["runs"] if r["id"] == "debate_mod1")
    assert mod["status"] == "completed"
    assert mod["role"] == "主持人"
    pro = next(r for r in p["runs"] if r["id"] == "debate_mod1_r1_pro")
    con = next(r for r in p["runs"] if r["id"] == "debate_mod1_r1_con")
    # stance/group/round 从 plan 透传；辩手 parent = 主持人节点（CEO→主持人→辩手树）。
    assert (pro["stance"], pro["group"], pro["round"]) == ("pro", "debate:debate", 1)
    assert (con["stance"], con["group"], con["round"]) == ("con", "debate:debate", 1)
    assert pro["parentRunId"] == "debate_mod1"


def test_multi_agent_debate_products(projected):
    """debate_result 折成 ProjectedTurn.debate：决策简报 + 交锋叙事线 verbatim，各方→辩手
    run_id 映射回执行图（取发言全文）。"""
    d = projected["multi_agent_debate"]["debate"]
    assert d is not None
    assert d["moderator_run_id"] == "debate_mod1"
    assert d["form"] == "debate"
    assert d["stop_reason"] == "converged"
    assert d["narrative_first"] is False
    # 决策简报（结论卡）。
    assert d["brief"]["leaning"] == "倾向有条件采用"
    assert d["brief"]["strongest_points"]["pro"] == "收益显著且可量化"
    # 交锋叙事线（逐轮焦点 / 裁判 / 小结）+ 各方→辩手 run_id 映射。
    rd = d["rounds"][0]
    assert rd["round_no"] == 1
    assert rd["verdict"]["converged"] is True
    assert rd["sides"][0]["run_id"] == "debate_mod1_r1_pro"


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


def test_multi_agent_plan_revised_trace(projected):
    # 「计划已调整」轻痕迹 (设计 §7.2): plan_revised folds each affected node's kind onto its
    # run's `revised` — "bind" (a late-bound node finalised from upstream) / "steer" (a
    # not-yet-run node re-steered). A node the plan never touched stays `revised=None`. The
    # trace NEVER pauses the turn: it completes end_turn with no pendingInteraction.
    p = projected["multi_agent_plan_revised"]
    assert p["status"] == "completed"
    assert p["pendingInteraction"] is None
    by_id = {r["id"]: r for r in p["runs"]}
    assert by_id["r1"]["revised"] is None
    assert by_id["r2"]["revised"] == "bind"
    assert by_id["r3"]["revised"] == "steer"
    assert p["progress"] == {"completed": 3, "total": 3}


def test_multi_agent_escalation_nonblocking_banner(projected):
    # 非阻塞 run_escalation: folded onto the raising run as a "raised" record (drives the
    # node ⚠️ badge); the worker kept working → COMPLETED. A sibling that never escalated
    # carries an empty list (no badge).
    p = projected["multi_agent_escalation"]
    assert p["status"] == "completed"
    r1 = next(r for r in p["runs"] if r["id"] == "r1")
    r2 = next(r for r in p["runs"] if r["id"] == "r2")
    assert r1["escalations"] == [
        {
            "question": "数据库选 Postgres 还是 MySQL？这关系到后续所有选型。",
            "assumption": "暂按 Postgres 推进",
            "blocking": True,
            "status": "raised",
            "answer": None,
        }
    ]
    assert r2["escalations"] == []


def test_multi_agent_blocking_escalate_resolved(projected):
    # 阻塞式求决策 答复路径: escalation_required → pending → escalation_resolved(resolved)
    # flips the run's escalation to resolved + answer. The turn NEVER pauses (non-halting).
    p = projected["multi_agent_blocking_escalate"]
    assert p["status"] == "completed"
    assert p["pendingInteraction"] is None
    r1 = next(r for r in p["runs"] if r["id"] == "r1")
    assert r1["escalations"] == [
        {
            "question": "数据库选 Postgres 还是 MySQL？这关系到后续所有选型，且猜错基本要整段返工。",
            "assumption": "暂按 Postgres 推进",
            "blocking": True,
            "status": "resolved",
            "answer": "用 Postgres。",
        }
    ]


def test_multi_agent_blocking_escalate_pending_does_not_pause(projected):
    # THE 核心不变量 (设计 §4.5/§七): a pending blocking escalate keeps the turn RUNNING (not
    # paused) and sets NO pendingInteraction — unlike approval/ask_user/plan_review halting
    # gates. The parallel sibling r2 keeps running, proving the escalation gates only its own
    # worker, never the wave.
    p = projected["multi_agent_blocking_escalate_pending"]
    assert p["status"] == "running"
    assert p["pendingInteraction"] is None
    r1 = next(r for r in p["runs"] if r["id"] == "r1")
    r2 = next(r for r in p["runs"] if r["id"] == "r2")
    assert r1["escalations"][0]["status"] == "pending"
    assert r1["escalations"][0]["answer"] is None
    assert r2["status"] == "running"


def test_multi_agent_blocking_escalate_timeout_falls_back(projected):
    # 超时降级 (安全基石 §4.4): escalation_resolved(timeout) flips the escalation to timeout
    # (answer None); the worker fell back to its assumption and COMPLETED — blocking is a
    # strict superset of today's non-blocking behaviour.
    p = projected["multi_agent_blocking_escalate_timeout"]
    assert p["status"] == "completed"
    assert p["pendingInteraction"] is None
    r1 = next(r for r in p["runs"] if r["id"] == "r1")
    assert r1["escalations"][0]["status"] == "timeout"
    assert r1["escalations"][0]["answer"] is None


def test_multi_agent_blocking_escalate_multi_settles_each(projected):
    # 多升级: one run raises two sequential blocking escalates — the first answered, the
    # second timed out. Each settles independently in fire order (the "find first pending"
    # fold is order-correct: when esc2 resolves, esc1 is already resolved so it targets esc2).
    p = projected["multi_agent_blocking_escalate_multi"]
    assert p["status"] == "completed"
    assert p["pendingInteraction"] is None
    r1 = next(r for r in p["runs"] if r["id"] == "r1")
    assert [(e["status"], e["answer"]) for e in r1["escalations"]] == [
        ("resolved", "用 Postgres。"),
        ("timeout", None),
    ]
