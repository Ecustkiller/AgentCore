"""Conformance vector builders — interactive gate pause/continue scenarios.

See ``vectors/__init__.py`` for the aggregated ``VECTORS`` registry.
"""

from __future__ import annotations

from collections.abc import Callable

from agentcore.runtime.events import (
    FinishReason,
    SSEEvent,
    approval_required,
    approval_resolved,
    checkpoint_required,
    checkpoint_resolved,
    content_delta,
    message_end,
    message_start,
    plan_review_required,
    plan_review_resolved,
    question_posted,
    reasoning_delta,
    run_completed,
    run_plan,
    run_started,
    team_preview_required,
    team_preview_resolved,
    tool_use_end,
    tool_use_start,
)

from ._common import _CONV, _COST, _USAGE


def _approval_paused() -> list[SSEEvent]:
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我需要运行代码。"),
        approval_required(
            approval_id="tc1",
            conversation_id=_CONV,
            tool_call_id="tc1",
            tool_name="code_execute",
            arguments={"code": "print(1)"},
        ),
    ]

def _approval_resolved_continue() -> list[SSEEvent]:
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我需要运行代码。"),
        approval_required(
            approval_id="tc1",
            conversation_id=_CONV,
            tool_call_id="tc1",
            tool_name="code_execute",
            arguments={"code": "print(1)"},
        ),
        approval_resolved(approval_id="tc1", tool_call_id="tc1", decision="approve"),
        tool_use_start("tc1", "code_execute", {"code": "print(1)"}),
        tool_use_end("tc1", "code_execute", success=True, output="1\n"),
        content_delta("运行结果是 1。"),
        message_end(FinishReason.END_TURN, input_tokens=900, output_tokens=80, cost=_COST),
    ]

def _plan_review_paused() -> list[SSEEvent]:
    agents = [
        {
            "id": "w1",
            "role": "调研",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "w2",
            "role": "执行",
            "model_preference": "fast",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    plan_runs = [
        {"id": "r1", "agent_id": "w1", "task": "出方案", "depends_on": []},
        {"id": "r2", "agent_id": "w2", "task": "落地", "depends_on": ["r1"]},
    ]
    return [
        message_start("m1", conversation_id=_CONV),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="分阶段",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        run_completed(
            "r1",
            "w1",
            output_summary="方案就绪",
            duration_ms=900,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        plan_review_required(
            checkpoint_id="cp1",
            conversation_id=_CONV,
            steps=[{"run_id": "r1", "role": "调研", "summary": "方案就绪"}],
            pending=[{"run_id": "r2", "role": "执行"}],
        ),
    ]

def _plan_review_resolved_continue() -> list[SSEEvent]:
    base = _plan_review_paused()
    return [
        *base,
        plan_review_resolved(checkpoint_id="cp1", decision="continue"),
        run_started("r2", "w2"),
        run_completed(
            "r2",
            "w2",
            output_summary="已落地",
            duration_ms=1100,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        message_end(FinishReason.END_TURN, input_tokens=3000, output_tokens=400, cost=_COST),
    ]

def _single_agent_checkpoint() -> list[SSEEvent]:
    """单聊·检查点 (ask_user blocking=true)：CEO 想清楚后向用户拍板、暂停回合。检查点在时间线
    **原位**落一个 `checkpoint` 标记（卡片正文另路 fold，按 checkpoint_id 取回），回合停在
    checkpoint_required（无 message_end）→ pendingInteraction=checkpoint、status=paused。
    验「检查点不再压到气泡底部、而是回到它真实发生的时序位」。"""
    return [
        message_start("m1", conversation_id=_CONV),
        reasoning_delta("这个需求有歧义，先问清楚。"),
        content_delta("开始前我确认一下方向："),
        checkpoint_required(
            checkpoint_id="cp1",
            conversation_id=_CONV,
            question="先做 A 还是 B？",
            context="两条路线各有取舍。",
            intent="kickoff",
        ),
    ]

def _single_agent_checkpoint_finalized() -> list[SSEEvent]:
    """单聊·检查点【收口即终止】(②)：ask_user(blocking) 落帧后【不再
    挂在内存 Future】，回合直接以 ``message_end(finish_reason=paused)`` 收口——流到此【终止】（对照
    ``_single_agent_checkpoint`` 的「停在 ``checkpoint_required``、无 ``message_end``」挂起态）。
    关键断言：``status`` 仍 ``paused``、``pendingInteraction`` 仍 checkpoint（同一张 resume 卡），但
    ``finishReason="paused"`` + ``cost`` 落账——客户端据「流以 paused 收尾」渲成单张 resume 卡（统一
    冷路 ``POST .../resume``，根除 live/durable 双态）。验「终止式挂起 == 挂起态的同一恢复面」。"""
    return [
        *_single_agent_checkpoint(),
        message_end(FinishReason.PAUSED, input_tokens=1900, output_tokens=210, cost=_COST),
    ]

def _single_agent_checkpoint_resolved() -> list[SSEEvent]:
    """单聊·检查点【冷路恢复】(② resume)：ask_user(blocking) 落帧暂停后，用户经
    ``POST .../resume`` 拍板续跑——``checkpoint_resolved`` 清掉 pendingInteraction、status 从
    paused 回 running，回合继续产出并正常 ``end_turn`` 收尾。对照 ``_single_agent_checkpoint``
    （停在 ``checkpoint_required`` 的挂起态）验「同一张 resume 卡在续跑后关闭、回合跑到底」。"""
    return [
        *_single_agent_checkpoint(),
        checkpoint_resolved(checkpoint_id="cp1", decision="continue"),
        content_delta("好，按 A 推进。"),
        content_delta(" 已完成初稿。"),
        message_end(FinishReason.END_TURN, input_tokens=2100, output_tokens=260, cost=_COST),
    ]

def _plan_review_finalized() -> list[SSEEvent]:
    """结构化挂起·计划复核【收口即终止】(②)：delegate ``checkpoint_after`` 落帧后回合以
    ``message_end(finish_reason=paused)`` 收口（对照 ``_plan_review_paused`` 的「停在
    ``plan_review_required``、无 ``message_end``」挂起态）。``status`` 仍 ``paused``、
    ``pendingInteraction`` 仍 plan_review、已完成 r1 仍带 checkpoint 徽标，但 ``finishReason="paused"``
    + ``cost`` 落账。delegate 的 plan_review 对偶，证终止式挂起在多 Agent 图上同样退回单张 resume 卡。"""
    return [
        *_plan_review_paused(),
        message_end(FinishReason.PAUSED, input_tokens=3000, output_tokens=400, cost=_COST),
    ]

def _single_agent_non_blocking_ask() -> list[SSEEvent]:
    """单聊·非阻塞发问 (ask_user blocking=false)：CEO 抛出一个已有默认值的问题但**继续干**，不
    挂起、不结算。时间线**原位**落一个 `ask` 标记（卡片正文另路 fold，按 ask_id 取回），回合
    照常 end_turn 收尾。验「非阻塞发问插在它真实发生的正文之间，而非堆到底部」。"""
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我先按常见默认推进。"),
        question_posted(
            ask_id="ask1",
            conversation_id=_CONV,
            question="需要同时导出 PDF 吗？",
            context="默认仅 Markdown。",
        ),
        content_delta(" 已完成初稿。"),
        message_end(FinishReason.END_TURN, input_tokens=1000, output_tokens=200, cost=_COST),
    ]


def _team_preview_finalized() -> list[SSEEvent]:
    """团队预审薄预览【收口即终止】：多 Agent 首委派在 run_plan 后、首波前挂起，以
    ``message_end(finish_reason=paused)`` 收口。``pendingInteraction`` = team_preview，
    时间线落 ``team_preview`` 标记；与 plan_review 波间闸门分离。"""
    agents = [
        {
            "id": "w1",
            "role": "调研",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "w2",
            "role": "撰写",
            "model_preference": "fast",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    plan_runs = [
        {"id": "r1", "agent_id": "w1", "task": "调研方案", "depends_on": []},
        {"id": "r2", "agent_id": "w2", "task": "写初稿", "depends_on": ["r1"]},
    ]
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来安排团队。"),
        tool_use_start(
            "dc1",
            "delegate",
            {"tasks": [{"role": "调研"}, {"role": "撰写"}], "coordinate": False},
        ),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="构建 X",
            agents=agents,
            runs=plan_runs,
        ),
        team_preview_required(
            checkpoint_id="tp1",
            conversation_id=_CONV,
            workers=[
                {
                    "run_id": "r1",
                    "role": "调研",
                    "task": "调研方案",
                    "depends_on": [],
                    "debate": False,
                },
                {
                    "run_id": "r2",
                    "role": "撰写",
                    "task": "写初稿",
                    "depends_on": ["r1"],
                    "debate": False,
                },
            ],
            tools=["code_execute", "file_write", "test_run"],
            primitive="delegate",
        ),
        message_end(FinishReason.PAUSED, input_tokens=1200, output_tokens=80, cost=_COST),
    ]


def _debate_team_preview_finalized() -> list[SSEEvent]:
    """辩论开工卡：顶层 debate 在主持人循环启动前挂起收口。"""
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来组织一场辩论。"),
        tool_use_start(
            "db1",
            "debate",
            {
                "motion": "该不该上四天工作制？",
                "form": "debate",
                "sides": [
                    {"key": "pro", "name": "正方", "stance": "应推广"},
                    {"key": "con", "name": "反方", "stance": "暂缓"},
                ],
                "thorough": True,
            },
        ),
        team_preview_required(
            checkpoint_id="tp-debate",
            conversation_id=_CONV,
            workers=[],
            tools=[],
            primitive="debate",
            motion="该不该上四天工作制？",
            form="debate",
            sides=[
                {"key": "pro", "name": "正方", "stance": "应推广"},
                {"key": "con", "name": "反方", "stance": "暂缓"},
            ],
            max_rounds=5,
            thorough=True,
        ),
        message_end(FinishReason.PAUSED, input_tokens=800, output_tokens=40, cost=_COST),
    ]


def _team_preview_resolved_continue() -> list[SSEEvent]:
    """团队预审放行后首波开跑到 end_turn。"""
    return [
        *_team_preview_finalized()[:-1],
        team_preview_resolved(checkpoint_id="tp1", decision="continue"),
        run_started("r1", "w1"),
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
        run_started("r2", "w2"),
        run_completed(
            "r2",
            "w2",
            output_summary="初稿完成",
            duration_ms=1100,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        tool_use_end("dc1", "delegate", success=True, output="团队完成"),
        content_delta("团队已交付。"),
        message_end(FinishReason.END_TURN, input_tokens=3000, output_tokens=400, cost=_COST),
    ]


VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "approval_paused": ("审批：approval_required 暂停（无 message_end）", _approval_paused),
    "approval_resolved_continue": ("审批：通过后继续到 end_turn", _approval_resolved_continue),
    "plan_review_paused": ("结构化挂起：plan_review_required 暂停", _plan_review_paused),
    "plan_review_resolved_continue": ("结构化挂起：放行后跑完下游", _plan_review_resolved_continue),
    "plan_review_finalized": ("结构化挂起：计划复核收口即终止（②，plan_review_required→message_end(paused)，单一冷路 resume）", _plan_review_finalized),
    "team_preview_finalized": ("团队预审：首波前挂起收口（finish_reason=paused）", _team_preview_finalized),
    "team_preview_resolved_continue": ("团队预审：开做后跑完首波", _team_preview_resolved_continue),
    "debate_team_preview_finalized": ("辩论开工卡：主持人循环前挂起收口", _debate_team_preview_finalized),
    "single_agent_checkpoint": ("单聊：检查点 ask_user(blocking) 在时间线原位落 checkpoint 标记 + 暂停", _single_agent_checkpoint),
    "single_agent_checkpoint_finalized": ("单聊：检查点收口即终止（②，checkpoint_required→message_end(paused)，单一冷路 resume）", _single_agent_checkpoint_finalized),
    "single_agent_checkpoint_resolved": ("单聊：检查点 ask_user(blocking) 经 resume 续跑（checkpoint_resolved 清挂起→跑到 end_turn）", _single_agent_checkpoint_resolved),
    "single_agent_non_blocking_ask": ("单聊：非阻塞发问 question_posted 在时间线原位落 ask 标记、回合照常收尾", _single_agent_non_blocking_ask),
}
