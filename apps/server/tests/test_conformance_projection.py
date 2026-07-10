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


def test_single_agent_checkpoint_finalized_stays_paused(projected):
    # 挂起即收口 (②): a checkpoint that FINALIZES the turn (a trailing message_end with
    # finish_reason=paused) must STAY paused with the SAME resume surface as the parked shape —
    # only finishReason + cost are added. Hand-verified so a correlated oracle+fold
    # "paused→completed" bug (the exact risk this new finish reason introduces, since all three
    # FINISH_TO_STATUS maps default unknown → completed) can't pass the gate by matching itself.
    p = projected["single_agent_checkpoint_finalized"]
    parked = projected["single_agent_checkpoint"]
    assert p["status"] == "paused"
    assert p["finishReason"] == "paused"
    # The terminal message_end bills the pre-pause spend (vs the parked shape's null cost).
    assert p["cost"]["total"] == 360_000
    assert parked["cost"] is None
    # Same single resume surface as the parked checkpoint — timeline + card body byte-identical,
    # so the client renders the one resume card whether the stream parked or finalized.
    assert p["pendingInteraction"] == parked["pendingInteraction"]
    assert p["process"] == parked["process"]
    assert p["content"] == parked["content"]


def test_plan_review_finalized_stays_paused(projected):
    # 挂起即收口 (②) 的 delegate 对偶: a plan_review that FINALIZES the turn stays paused with the
    # gated node's checkpoint badge + progress intact; only finishReason + cost are added vs the
    # parked shape, so the multi-agent graph退回 the same single resume card.
    p = projected["plan_review_finalized"]
    parked = projected["plan_review_paused"]
    assert p["status"] == "paused"
    assert p["finishReason"] == "paused"
    assert p["cost"]["total"] == 360_000
    assert p["pendingInteraction"] == {
        "kind": "plan_review",
        "checkpointId": "cp1",
        "runIds": ["r1"],
    }
    assert p["runs"][0]["checkpoint"] == {"status": "pending", "decision": None}
    assert p["progress"] == {"completed": 1, "total": 2}
    # Same resume surface as the parked plan_review — only the terminal frame differs.
    assert p["pendingInteraction"] == parked["pendingInteraction"]
    assert p["runs"] == parked["runs"]


def test_team_preview_finalized(projected):
    p = projected["team_preview_finalized"]
    assert p["status"] == "paused"
    assert p["finishReason"] == "paused"
    assert p["pendingInteraction"] == {
        "kind": "team_preview",
        "checkpointId": "tp1",
        "workerIds": ["r1", "r2"],
    }
    assert any(
        s.get("kind") == "team_preview" and s.get("checkpoint_id") == "tp1"
        for s in p["process"]
    )


def test_team_preview_resolved_continue(projected):
    p = projected["team_preview_resolved_continue"]
    assert p["status"] == "completed"
    assert p["pendingInteraction"] is None
    assert p["progress"]["completed"] == 2


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
    # 进度含主持人节点 + 各方立论 + 各 beat 的续写节点（revision 合成为独立 run，与桌面 projectExecution
    # 同口径）：1 主持人 + 2 辩手立论 + 2 质询作答（P1 revision）+ 2 结辩（P4·结辩收束 revision）= 7/7
    # （CEO 不进图，是主气泡）。
    assert p["progress"] == {"completed": 7, "total": 7}
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


def test_multi_agent_lead_subplan_bind_replan_nests_and_traces(projected):
    # 受监督子计划 B (docs/03-AI核心/编排器与CEO主Agent.md §2.4): a LEAD's sub-plan shares the parent
    # execution_id, so the two run_plans MERGE into one team graph linked by parentRunId (NOT a
    # reset) — sa/sb hang under the lead L1. The lead's OWN replan finalises the late-bound sb
    # (revised="bind") without pausing the turn; one `team` marker despite two run_plans.
    p = projected["multi_agent_lead_subplan_bind_replan"]
    assert p["status"] == "completed"
    assert p["pendingInteraction"] is None
    assert [s["execution_id"] for s in p["process"] if s["kind"] == "team"] == ["exec1"]
    by_id = {r["id"]: r for r in p["runs"]}
    assert by_id["L1"]["parentRunId"] is None  # the lead is a top-level worker (CEO is the bubble)
    assert by_id["sa"]["parentRunId"] == "L1"  # sub-team nests under the lead — graph NOT reset
    assert by_id["sb"]["parentRunId"] == "L1"
    assert by_id["sb"]["revised"] == "bind"  # the lead's own late-bind finalise is visible
    assert by_id["sa"]["revised"] is None
    assert by_id["L1"]["revised"] is None
    assert p["progress"] == {"completed": 3, "total": 3}


def test_multi_agent_lead_subplan_scope_steer_nests_and_traces(projected):
    # 受监督子计划 B 自底向上 (SCOPE 臂): a sub-worker (sa) reports a scope deviation
    # (run_escalation, non-blocking → node ⚠️ badge, turn not paused); the lead catches the
    # SCOPE boundary and its OWN replan re-steers the un-run downstream sb (revised="steer").
    # Same shared-execution_id nesting (sa/sb under L1) as the bind arm.
    p = projected["multi_agent_lead_subplan_scope_steer"]
    assert p["status"] == "completed"
    assert p["pendingInteraction"] is None
    by_id = {r["id"]: r for r in p["runs"]}
    assert by_id["sa"]["parentRunId"] == "L1"
    assert by_id["sb"]["parentRunId"] == "L1"
    assert by_id["sb"]["revised"] == "steer"
    assert by_id["sb"]["escalations"] == []
    assert by_id["sa"]["escalations"] == [
        {
            "question": "真正要做的是 X 而非初始子计划的 Y，下游写法应随之调整。",
            "assumption": "暂按 X 推进",
            "blocking": False,
            "status": "raised",
            "answer": None,
            "kind": "scope",
        }
    ]
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
            "kind": "normal",
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
            "kind": "normal",
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


def test_multi_agent_ceo_arbitrate_escalate_direct(projected):
    p = projected["multi_agent_ceo_arbitrate_escalate"]
    assert p["status"] == "completed"
    assert p["pendingInteraction"] is None
    r1 = next(r for r in p["runs"] if r["id"] == "r1")
    assert len(r1["escalations"]) == 1
    esc = r1["escalations"][0]
    assert esc["status"] == "resolved"
    assert esc["awaiting"] == "ceo"
    assert esc["arbitrated_by"] == "ceo"
    assert esc["via_user"] is False
    assert esc["answer"] == "用 Postgres。"


def test_multi_agent_ceo_arbitrate_escalate_via_user(projected):
    p = projected["multi_agent_ceo_arbitrate_escalate_via_user"]
    r1 = next(r for r in p["runs"] if r["id"] == "r1")
    esc = r1["escalations"][0]
    assert esc["status"] == "resolved"
    assert esc["arbitrated_by"] == "ceo"
    assert esc["via_user"] is True
    assert "用户确认" in esc["answer"]


def test_multi_agent_team_notes_kinds(projected):
    # 三类便签 kind (§2.2 通): decision 我定了 / heads_up 提个醒 / claim 我领了 (claim = WriteCoordinator
    # 的台面化). Hand-verified so the oracle's kind passthrough can't silently drop / coerce the claim
    # kind, and notes stay orthogonal to the run graph (post order, all active, not in runs/process).
    p = projected["multi_agent_team_notes"]
    assert p["status"] == "completed"
    by_id = {n["noteId"]: n for n in p["teamNotes"]}
    assert by_id["n1"]["kind"] == "decision"
    assert by_id["n2"]["kind"] == "heads_up"
    assert by_id["n3"]["kind"] == "claim"
    assert by_id["n3"]["text"] == "示例文档这部分我来写，别人不用重复"
    assert [n["noteId"] for n in p["teamNotes"]] == ["n1", "n2", "n3"]
    assert all(n["status"] == "active" for n in p["teamNotes"])


def test_multi_agent_team_notes_amended_supersession(projected):
    # 便签会过期 → supersession (§2.2): an AMENDMENT note (carries `supersedes` + `supersede_mode`)
    # marks its TARGET superseded (改写) / voided (作废), while staying active itself. Hand-verified
    # here so the oracle's status-flip can't pass by matching a fold that makes the same mistake.
    p = projected["multi_agent_team_notes_amended"]
    assert p["status"] == "completed"
    by_id = {n["noteId"]: n for n in p["teamNotes"]}
    # n3 改写 n1 → n1 superseded; the amendment is active and points back at its origin.
    assert by_id["n1"]["status"] == "superseded"
    assert by_id["n1"]["supersedes"] is None
    assert by_id["n3"]["status"] == "active"
    assert by_id["n3"]["supersedes"] == "n1"
    assert by_id["n3"]["text"] == "登录字段改用 pwd（替代 password）"
    # n4 作废 n2 → n2 voided; the retraction note is active and links to its origin.
    assert by_id["n2"]["status"] == "voided"
    assert by_id["n4"]["status"] == "active"
    assert by_id["n4"]["supersedes"] == "n2"
    # All four notes are kept in post order (stale ones stay visible, just tagged).
    assert [n["noteId"] for n in p["teamNotes"]] == ["n1", "n3", "n2", "n4"]


def test_multi_agent_team_notes_ceo_seed_and_brief(projected):
    # Phase 2 共享便签：CEO 播种便签带 source=ceo；worker run_context 含 team_brief 块。
    p = projected["multi_agent_team_notes_ceo_seed"]
    assert p["status"] == "completed"
    by_id = {n["noteId"]: n for n in p["teamNotes"]}
    assert by_id["n0"]["source"] == "ceo"
    assert by_id["n0"]["role"] == "主协调"
    assert by_id["n1"]["source"] == "ceo"
    assert by_id["n2"]["kind"] == "heads_up"
    assert "source" not in by_id["n2"] or by_id["n2"].get("source") != "ceo"
    assert [n["noteId"] for n in p["teamNotes"]] == ["n0", "n1", "n2"]
    brief_blocks = [
        b
        for r in p["runs"]
        for b in (r.get("receivedContext") or [])
        if b.get("channel") == "team_brief"
    ]
    assert len(brief_blocks) == 2
    assert "初学者" in brief_blocks[0]["body"]


def test_process_tool_result_cap_matches_sink():
    """>8KB tool results: sink process timeline and oracle projection must agree.

    Journal stores the full wire payload; reload folds through ``project_turn``. Live
    runtime caps in ``EventSink._accumulate_process`` — the oracle must apply the same
    ``cap_process_result`` so golden/reload/live stay aligned."""
    from agentcore.conformance.projection import project_turn
    from agentcore.runtime.events import EventSink, tool_use_end, tool_use_start
    from agentcore.runtime.events.journal_config import _PROCESS_RESULT_CAP, cap_process_result

    big = "x" * (_PROCESS_RESULT_CAP + 500)
    expected = cap_process_result(big)
    assert isinstance(expected, str)
    assert len(expected) == _PROCESS_RESULT_CAP + 1  # cap + ellipsis

    sink = EventSink()
    sink.emit(tool_use_start("tc_big", "read_url", {"url": "https://example.com"}))
    sink.emit(tool_use_end("tc_big", "read_url", success=True, output=big))

    sink_tool = next(s for s in (sink.process_timeline() or []) if s.get("kind") == "tool")
    assert sink_tool["result"] == expected

    # Uncapped wire events (as journaled / reloaded) — oracle must cap on fold.
    events = [
        {
            "type": "tool_use_start",
            "payload": {
                "tool_call_id": "tc_big",
                "tool_name": "read_url",
                "arguments": {"url": "https://example.com"},
            },
            "timestamp": "2026-01-01T00:00:00.000Z",
        },
        {
            "type": "tool_use_end",
            "payload": {
                "tool_call_id": "tc_big",
                "tool_name": "read_url",
                "status": "success",
                "result": big,
            },
            "timestamp": "2026-01-01T00:00:00.001Z",
        },
    ]
    oracle_tool = next(s for s in project_turn(events)["process"] if s.get("kind") == "tool")
    assert oracle_tool["result"] == expected
    assert oracle_tool["result"] == sink_tool["result"]
