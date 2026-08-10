"""跨回合同图追加 conformance 向量。

第一回合建图完成 → 第二回合 ``append_to_execution_id`` 追加 → 追加批完成收口。
消费端契约：(a) 生长帧 ``host_message_id`` / 同 ``execution_id`` 归属旧图；
(b) 新回合 ``graph_append`` 锚点；(c) 刷新后宿主 journal 含完整生长、追加回合仅锚点；
(d) 两回合 ``run_plan`` 均含**同一**宿主 captain（``kind=captain``），merge 全量禁止注入
第二 captain；workers 的 ``parent_run_id`` 指向宿主 captain（贴近生产 ``plan_event``）。
"""

from __future__ import annotations

from agentcore.runtime.events import (
    FinishReason,
    SSEEvent,
    content_delta,
    graph_append,
    message_end,
    message_start,
    run_completed,
    run_output_delta,
    run_plan,
    run_started,
    tool_use_end,
    tool_use_start,
)

from .._common import _CONV, _COST, _USAGE

# 宿主图唯一 CEO captain（跨回合 append 仍复用此 id，禁止第二 captain）。
_HOST_CAPTAIN = "c1"


def _captain_agent() -> dict:
    """Roster card — mirrors ``plan_events.captain_card``."""
    return {"id": _HOST_CAPTAIN, "role": "CEO", "thinking": True}


def _captain_run() -> dict:
    """Plan-time captain root — mirrors ``plan_events.plan_event`` insert."""
    return {
        "id": _HOST_CAPTAIN,
        "agent_id": _HOST_CAPTAIN,
        "task": "",
        "depends_on": [],
        "parent_run_id": None,
        "kind": "captain",
    }


def _worker_run(
    run_id: str,
    agent_id: str,
    task: str,
    *,
    depends_on: list[str] | None = None,
) -> dict:
    """Worker plan node under the host captain (production flat parent semantics)."""
    return {
        "id": run_id,
        "agent_id": agent_id,
        "task": task,
        "depends_on": list(depends_on or []),
        "parent_run_id": _HOST_CAPTAIN,
    }


def _multi_agent_cross_turn_append() -> list[SSEEvent]:
    """跨回合同图追加：m1 建图完成 → m2 追加成员 → 追加批完成；图收口不绑 m2 message_end。

    两回合 merge ``run_plan`` 均只有同一宿主 captain；第二回合新增 worker，不出现第二
    captain id（契约：生产不再往宿主图注入追加回合 captain）。
    """
    batch1_agents = [
        _captain_agent(),
        {"id": "w1", "role": "研究员", "thinking": True},
        {"id": "w2", "role": "分析师", "thinking": True},
    ]
    batch1_runs = [
        _captain_run(),
        _worker_run("r1", "w1", "调研素材"),
        _worker_run("r2", "w2", "分析结论", depends_on=["r1"]),
    ]
    batch2_agents = [
        _captain_agent(),
        {"id": "w1", "role": "研究员", "thinking": True},
        {"id": "w2", "role": "分析师", "thinking": True},
        {"id": "w3", "role": "撰写员", "thinking": True},
    ]
    # 第二批 run_plan 为 merge 全量（含旧节点 + 新节点），与生产 plan_event 一致：
    # 仍只有同一宿主 captain，新增 worker；禁止第二 captain id。
    batch2_runs = [
        _captain_run(),
        _worker_run("r1", "w1", "调研素材"),
        _worker_run("r2", "w2", "分析结论", depends_on=["r1"]),
        _worker_run("r3", "w3", "撰写文稿"),
    ]
    return [
        # ── 回合 1：建图并完成 ──
        # 宿主 captain 仅由 run_plan 声明（贴近 plan_event 插根）；不另发 plan 前
        # run_started——否则桌面 projectExecution 会把帧收成 running，与 oracle
        # finalize(pending→skipped) 分叉。本向量钉的是「单 captain + parent」，非 captain 生命周期。
        message_start("m1", conversation_id=_CONV),
        content_delta("先组队调研分析。"),
        tool_use_start(
            "dc1",
            "delegate",
            {
                "tasks": [{"role": "研究员"}, {"role": "分析师"}],
                "coordinate": False,
            },
        ),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="调研分析",
            agents=batch1_agents,
            runs=batch1_runs,
        ),
        run_started("r1", "w1", parent_run_id=_HOST_CAPTAIN),
        run_output_delta("r1", "w1", "素材就绪"),
        run_completed(
            "r1",
            "w1",
            output_summary="调研完成",
            duration_ms=900,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started("r2", "w2", parent_run_id=_HOST_CAPTAIN),
        run_output_delta("r2", "w2", "分析定稿"),
        run_completed(
            "r2",
            "w2",
            output_summary="分析完成",
            duration_ms=1100,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        tool_use_end("dc1", "delegate", success=True, output="团队完成 2 项任务。"),
        content_delta(" 第一轮结论已汇总。"),
        message_end(FinishReason.END_TURN, input_tokens=4000, output_tokens=700, cost=_COST),
        # ── 回合 2：跨回合同图追加 ──
        message_start("m2", conversation_id=_CONV),
        content_delta("再往上一张图加一位撰写员。"),
        tool_use_start(
            "dc2",
            "delegate",
            {
                "tasks": [{"role": "撰写员", "task": "撰写文稿"}],
                "append_to_execution_id": "exec1",
                "coordinate": False,
            },
        ),
        graph_append(
            execution_id="exec1",
            host_message_id="m1",
            append_message_id="m2",
            added_count=1,
            roles=["撰写员"],
            added_run_ids=["r3"],
        ),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="调研分析撰写",
            agents=batch2_agents,
            runs=batch2_runs,
            host_message_id="m1",
        ),
        run_started("r3", "w3", parent_run_id=_HOST_CAPTAIN),
        run_output_delta("r3", "w3", "成稿"),
        run_completed(
            "r3",
            "w3",
            output_summary="撰写完成",
            duration_ms=1000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        tool_use_end(
            "dc2",
            "delegate",
            success=True,
            output="【跨回合同图追加】已往协作图追加 1 名成员。",
        ),
        content_delta(" 已追加撰写员，图上继续更新。"),
        # m2 收口；图完成态由 execution 自身 run 终态决定（本向量中 r3 已完成）。
        message_end(FinishReason.END_TURN, input_tokens=2000, output_tokens=400, cost=_COST),
    ]
