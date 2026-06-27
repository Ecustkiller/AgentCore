"""Conformance vector builders — multi-agent orchestration scenarios.

See ``vectors/__init__.py`` for the aggregated ``VECTORS`` registry.
"""

from __future__ import annotations

from agentcore.runtime.events import (
    FinishReason,
    content_delta,
    escalation_raised,
    escalation_required,
    escalation_resolved,
    message_end,
    message_start,
    plan_revised,
    run_completed,
    run_context,
    run_output_delta,
    run_output_reset,
    run_plan,
    run_reasoning_delta,
    run_started,
    run_tool_progress,
    tool_use_end,
    tool_use_start,
)

from ._common import _CONV, _COST, _USAGE, _ESC_Q, _ESC_A, _ctx_block

from collections.abc import Callable

def _multi_agent_delegate() -> list[SSEEvent]:
    agents = [
        {
            "id": "w1",
            "role": "研究员",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "w2",
            "role": "撰写员",
            "model_preference": "fast",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    plan_runs = [
        {"id": "r1", "agent_id": "w1", "task": "调研", "depends_on": []},
        {"id": "r2", "agent_id": "w2", "task": "撰写", "depends_on": ["r1"]},
    ]
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来安排团队。"),
        # The CEO's `delegate` tool call: in production it emits a top-level
        # tool_use_start (before run_plan) and resolves after the team finishes — this
        # `delegate` step is where the client slots the inline team graph (统一团队时间线).
        tool_use_start("dc1", "delegate", {"tasks": [{"role": "研究员"}, {"role": "撰写员"}]}),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="构建 X",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        run_output_delta("r1", "w1", "调研结论"),
        run_completed(
            "r1",
            "w1",
            output_summary="完成调研",
            duration_ms=1000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started("r2", "w2"),
        run_output_delta("r2", "w2", "成稿"),
        run_completed(
            "r2",
            "w2",
            output_summary="完成撰写",
            duration_ms=1200,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        # delegate resolves only after the whole team finishes (it blocks the CEO round).
        tool_use_end("dc1", "delegate", success=True, output="团队完成 2 项任务。"),
        content_delta(" 团队已完成。"),
        message_end(FinishReason.END_TURN, input_tokens=4000, output_tokens=800, cost=_COST),
    ]

def _multi_agent_worker_tool() -> list[SSEEvent]:
    """多 Agent：worker 工具调用。worker 的 ``tool_use_start/end`` 与 CEO 的同形地走顶层流，
    但**携 ``run_id``**——三端 process fold 据此把它**排除出 CEO 气泡时间线**（统一团队时间线
    只放 CEO 自己的步骤）；归属由团队图按运行中 run 承载（``toolCalls``，ProjectedTurn 略去）。
    故本向量验「worker 工具不串进 CEO ``process``」：``process`` 只剩 CEO 正文「我来分工。」。
    ``run_tool_progress`` 是唯一持久可观测（→ ``agent.toolProgress``）。末尾不发 ``message_end``：
    w2 停在「正在生成」快照，故其 ``toolProgress`` 可见。"""
    agents = [
        {
            "id": "w1",
            "role": "工程师",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "w2",
            "role": "测试员",
            "model_preference": "fast",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    plan_runs = [
        {"id": "r1", "agent_id": "w1", "task": "写代码", "depends_on": []},
        {"id": "r2", "agent_id": "w2", "task": "跑测试", "depends_on": ["r1"]},
    ]
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来分工。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="实现 + 测试",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        run_tool_progress("r1", "w1", "file_write", 1200),
        tool_use_start("tc1", "file_write", {"path": "a.py", "content": "print(1)"}, run_id="r1"),
        tool_use_end("tc1", "file_write", success=True, output="已写入", run_id="r1"),
        run_output_delta("r1", "w1", "代码就绪"),
        run_completed(
            "r1",
            "w1",
            output_summary="实现完成",
            duration_ms=1500,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started("r2", "w2"),
        run_tool_progress("r2", "w2", "code_execute", 64),
    ]

def _multi_agent_revision() -> list[SSEEvent]:
    """多 Agent：定向唤回续写 (乙 热修 P4)。修订 run(``revision=2`` + ``parent_run_id``)不在
    plan 里——三端都从其 ``run_started`` 帧合成出一个修订节点 + 继承原 agent 身份的新 agent。"""
    agents = [
        {
            "id": "w1",
            "role": "撰写员",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    plan_runs = [
        {"id": "r1", "agent_id": "w1", "task": "起草", "depends_on": []},
    ]
    return [
        message_start("m1", conversation_id=_CONV),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="起草并修订",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        run_output_delta("r1", "w1", "初稿"),
        run_completed(
            "r1",
            "w1",
            output_summary="初稿完成",
            duration_ms=900,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started("r1v2", "w1b", parent_run_id="r1", revision=2),
        run_output_delta("r1v2", "w1b", "修订稿"),
        run_completed(
            "r1v2",
            "w1b",
            output_summary="修订完成",
            duration_ms=600,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        message_end(FinishReason.END_TURN, input_tokens=2000, output_tokens=400, cost=_COST),
    ]

def _multi_agent_plan_revised() -> list[SSEEvent]:
    """多 Agent：自主再绑定「计划已调整」轻痕迹 (受监督的波循环, 设计 §7.2)。计划含一个待定稿的
    下游节点（r2 撰写，``bind_after_deps``）+ 一个未跑下游（r3 复核）。r1 调研跑完触到波边界 → CEO
    据上游产出调 ``replan``：定稿 r2 的职责（``bind``）并操舵 r3 的复核重点（``steer``），发一条
    ``plan_revised`` → 三端把 ``revised`` 折到对应节点（r2=bind / r3=steer，r1 恒 None）；定稿/操舵
    后同一 DAG 续跑 r2、r3。验「自我纠偏看得见不打断」：节点带轻痕迹，回合照常 end_turn。
    ``revised`` 随 ``run_plan`` 节点默认 None，故所有既有向量的 runs 也都新增 ``revised: null``。"""
    agents = [
        {
            "id": "w1",
            "role": "研究员",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "w2",
            "role": "撰写员",
            "model_preference": "fast",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "w3",
            "role": "复核员",
            "model_preference": "fast",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    plan_runs = [
        {"id": "r1", "agent_id": "w1", "task": "调研竞品定价", "depends_on": []},
        {"id": "r2", "agent_id": "w2", "task": "（依赖完成后再定稿）", "depends_on": ["r1"]},
        {"id": "r3", "agent_id": "w3", "task": "复核成稿", "depends_on": ["r2"]},
    ]
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来安排团队。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="定价分析（含晚绑定下游）",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        run_output_delta("r1", "w1", "竞品定价区间……"),
        run_completed(
            "r1",
            "w1",
            output_summary="完成竞品定价调研",
            duration_ms=1000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        # 波边界让出 → CEO 据 r1 产出定稿 r2（bind）并操舵 r3 复核重点（steer），发轻痕迹。
        plan_revised(
            execution_id="exec1",
            revisions=[
                {"run_id": "r2", "kind": "bind"},
                {"run_id": "r3", "kind": "steer"},
            ],
        ),
        run_started("r2", "w2"),
        run_output_delta("r2", "w2", "据调研撰写定价建议……"),
        run_completed(
            "r2",
            "w2",
            output_summary="完成定价建议",
            duration_ms=1200,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started("r3", "w3"),
        run_output_delta("r3", "w3", "复核通过，补一处口径……"),
        run_completed(
            "r3",
            "w3",
            output_summary="复核完成",
            duration_ms=700,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        content_delta(" 团队已完成（计划据中途发现调整过）。"),
        message_end(FinishReason.END_TURN, input_tokens=4200, output_tokens=820, cost=_COST),
    ]

def _multi_agent_multi_batch() -> list[SSEEvent]:
    """多 Agent：同一回合两批 ``delegate``（同 ``execution_id``）。第二批合并进现有图（不重置），
    进度跨批累计（来自 run 状态、非每批 run_progress 计数器）。"""
    batch1_agents = [
        {
            "id": "w1",
            "role": "研究员",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    batch1_runs = [{"id": "r1", "agent_id": "w1", "task": "调研", "depends_on": []}]
    batch2_agents = [
        {
            "id": "w2",
            "role": "撰写员",
            "model_preference": "fast",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    batch2_runs = [{"id": "r2", "agent_id": "w2", "task": "撰写", "depends_on": ["r1"]}]
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("先调研。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="分两批",
            agents=batch1_agents,
            runs=batch1_runs,
        ),
        run_started("r1", "w1"),
        run_output_delta("r1", "w1", "调研完成"),
        run_completed(
            "r1",
            "w1",
            output_summary="调研结论",
            duration_ms=1000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        content_delta(" 再撰写。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="分两批",
            agents=batch2_agents,
            runs=batch2_runs,
        ),
        run_started("r2", "w2"),
        run_output_delta("r2", "w2", "成稿"),
        run_completed(
            "r2",
            "w2",
            output_summary="撰写完成",
            duration_ms=1100,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        message_end(FinishReason.END_TURN, input_tokens=5000, output_tokens=900, cost=_COST),
    ]

def _multi_agent_received_context() -> list[SSEEvent]:
    """多 Agent：收到的上下文 (上下文传递可视化)。每个 worker 在 ``run_started`` 后 emit 一条
    ``run_context``——结构化承载它被喂进 LLM 的开场（单一源：用户看到的 == LLM 吃到的）。r1
    研究员收到【原始请求 + 团队位置 + 任务】三通道；r2 撰写员还多一条【前置结果】依赖块，带来源
    溯源（``source_role``/``source_run_id``）、保真度（``fidelity=pass_through``）与是否被预算截断
    （``truncated``）。三端 fold + oracle 必须把 blocks verbatim 折到对应 run 的 ``receivedContext``
    （conformance pins them equal）。"""
    agents = [
        {
            "id": "w1",
            "role": "研究员",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "w2",
            "role": "撰写员",
            "model_preference": "fast",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    plan_runs = [
        {"id": "r1", "agent_id": "w1", "task": "调研竞品定价", "depends_on": []},
        {"id": "r2", "agent_id": "w2", "task": "撰写定价建议", "depends_on": ["r1"]},
    ]
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来安排团队。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="竞品定价分析与建议",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        run_context(
            "r1",
            "w1",
            [
                _ctx_block(
                    "request",
                    "原始用户请求（老板交给整个团队的目标，不一定全是你的活；你的具体职责见下方「你的任务」）",
                    "调研主流竞品的定价并给出我们的定价建议。",
                ),
                _ctx_block(
                    "team_position",
                    "你在团队中的位置",
                    "并行队友：撰写员（撰写定价建议）。你的产出将交给：撰写员。",
                ),
                _ctx_block("task", "你的任务", "调研竞品定价"),
            ],
        ),
        run_output_delta("r1", "w1", "竞品 A/B/C 的定价区间……"),
        run_completed(
            "r1",
            "w1",
            output_summary="完成竞品定价调研",
            duration_ms=1000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started("r2", "w2"),
        run_context(
            "r2",
            "w2",
            [
                _ctx_block(
                    "request",
                    "原始用户请求（老板交给整个团队的目标，不一定全是你的活；你的具体职责见下方「你的任务」）",
                    "调研主流竞品的定价并给出我们的定价建议。",
                ),
                _ctx_block(
                    "team_position",
                    "你在团队中的位置",
                    "上游依赖：研究员（调研竞品定价）。你的产出汇总给老板。",
                ),
                _ctx_block(
                    "dependency",
                    "前置结果（来自 研究员）",
                    "竞品 A/B/C 的定价区间与档位拆分……",
                    source_role="研究员",
                    source_run_id="r1",
                    fidelity="pass_through",
                    truncated=False,
                ),
                _ctx_block("task", "你的任务", "撰写定价建议"),
            ],
        ),
        run_output_delta("r2", "w2", "建议采用三档定价……"),
        run_completed(
            "r2",
            "w2",
            output_summary="完成定价建议",
            duration_ms=1200,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        content_delta(" 团队已完成。"),
        message_end(FinishReason.END_TURN, input_tokens=4200, output_tokens=820, cost=_COST),
    ]

def _multi_agent_escalation() -> list[SSEEvent]:
    """多 Agent：worker 升级实时可见 (escalation 实时 SSE)。被委派的 r1 撞到只有上级能定的关键
    岔路，调 ``escalate`` 走唯一向上通道——执行器在【调用瞬间】emit ``run_escalation``（run 级），
    三端 fold + oracle 把它折到 r1 的 ``escalations``（节点 ⚠️ 标记 + 回合级实时提示），r2 的
    ``escalations`` 恒空。escalate 非阻塞：r1 报完仍按假设继续交付并 COMPLETED（升级的持久副本另走
    RunState.escalations → CEO 综述，本事件只补「进行中可见」）。"""
    agents = [
        {
            "id": "w1",
            "role": "研究员",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "w2",
            "role": "撰写员",
            "model_preference": "fast",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    plan_runs = [
        {"id": "r1", "agent_id": "w1", "task": "调研选型", "depends_on": []},
        {"id": "r2", "agent_id": "w2", "task": "撰写建议", "depends_on": ["r1"]},
    ]
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来安排团队。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="选型并给建议",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        # 调用瞬间 emit：升级先于 r1 的产出/完成（实时，非收场 harvest）。
        escalation_raised(
            "r1",
            "w1",
            question="数据库选 Postgres 还是 MySQL？这关系到后续所有选型。",
            assumption="暂按 Postgres 推进",
            blocking=True,
        ),
        run_output_delta("r1", "w1", "已按 Postgres 完成选型调研"),
        run_completed(
            "r1",
            "w1",
            output_summary="完成选型调研（含 1 条升级）",
            duration_ms=1000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started("r2", "w2"),
        run_output_delta("r2", "w2", "基于选型给出建议"),
        run_completed(
            "r2",
            "w2",
            output_summary="完成建议",
            duration_ms=1200,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        content_delta(" 团队已完成（有 1 条待你拍板的升级）。"),
        message_end(FinishReason.END_TURN, input_tokens=4200, output_tokens=820, cost=_COST),
    ]

def _blocking_escalate_team() -> tuple[list[dict], list[dict]]:
    """The shared 2-worker plan: r1 (研究员) escalates; r2 (撰写员) depends on r1."""
    agents = [
        {
            "id": "w1",
            "role": "研究员",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "w2",
            "role": "撰写员",
            "model_preference": "fast",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    plan_runs = [
        {"id": "r1", "agent_id": "w1", "task": "调研选型", "depends_on": []},
        {"id": "r2", "agent_id": "w2", "task": "撰写建议", "depends_on": ["r1"]},
    ]
    return agents, plan_runs

def _multi_agent_blocking_escalate() -> list[SSEEvent]:
    """多 Agent：阻塞式求决策 (escalate blocking=true) — 答复路径。r1 撞到「只有用户能定、且猜错
    就作废」的关键岔路，调 escalate(blocking=true) 原地挂起 → 执行器 emit ``escalation_required``
    （run 级，``escalation_id`` 键给 resolve 端点），三端 fold + oracle 把它折成 r1 的一条 pending
    升级（``status="pending"``）。关键：阻塞升级【不】把回合翻 paused——兄弟仍可跑（区别于 approval/
    ask_user/plan_review 的 halting gate），故 ``pendingInteraction`` 恒 None。用户答复 →
    ``escalation_resolved(status="resolved", answer)``（单一发射者：仅挂起的工具发）→ 该项翻
    ``{status:"resolved", answer}``，r1 据答续跑并 COMPLETED。"""
    agents, plan_runs = _blocking_escalate_team()
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来安排团队。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="选型并给建议",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        # 阻塞挂起：把问题直接送到用户（CEO 停在 delegate、够不到用户）。
        escalation_required("r1", "w1", escalation_id="esc1", question=_ESC_Q, assumption=_ESC_A),
        # 用户答复 → 该项翻 resolved，r1 据答续跑（以用户答复为准）。
        escalation_resolved(
            "r1", "w1", escalation_id="esc1", status="resolved", answer="用 Postgres。"
        ),
        run_output_delta("r1", "w1", "已确认 Postgres，完成选型调研"),
        run_completed(
            "r1",
            "w1",
            output_summary="完成选型调研（用户已拍板 Postgres）",
            duration_ms=1000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started("r2", "w2"),
        run_output_delta("r2", "w2", "基于选型给出建议"),
        run_completed(
            "r2",
            "w2",
            output_summary="完成建议",
            duration_ms=1200,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        content_delta(" 团队已完成。"),
        message_end(FinishReason.END_TURN, input_tokens=4200, output_tokens=820, cost=_COST),
    ]

def _multi_agent_blocking_escalate_timeout() -> list[SSEEvent]:
    """多 Agent：阻塞式求决策 — 超时降级路径（安全基石 §4.4）。r1 阻塞挂起（``escalation_required``
    → pending），但用户在时限内未答（或选「按假设继续」）→ 执行器 emit ``escalation_resolved(status=
    "timeout")``（单一发射者，``answer`` 空）→ 该项翻 ``{status:"timeout", answer:null}``，r1 回落到
    它写明的 ``assumption`` 续跑并 COMPLETED。即阻塞 escalate 是「今日非阻塞行为的严格超集」：先等
    用户 T 秒，等不到就退回今天的样子，不可能回归。注：后端在超时分支【仍 emit】escalation_resolved
    （单一发射者载 disposition=timeout），与设计 §七「超时变体」的真实实现一致。"""
    agents, plan_runs = _blocking_escalate_team()
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来安排团队。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="选型并给建议",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        escalation_required("r1", "w1", escalation_id="esc1", question=_ESC_Q, assumption=_ESC_A),
        # 超时（或「按假设继续」）→ 同一 resolve 端点的 timeout disposition，answer 空。
        escalation_resolved("r1", "w1", escalation_id="esc1", status="timeout", answer=""),
        run_output_delta("r1", "w1", "未获答复，按 Postgres 假设完成选型调研"),
        run_completed(
            "r1",
            "w1",
            output_summary="完成选型调研（超时按假设 Postgres 续跑）",
            duration_ms=1000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started("r2", "w2"),
        run_output_delta("r2", "w2", "基于选型给出建议"),
        run_completed(
            "r2",
            "w2",
            output_summary="完成建议",
            duration_ms=1200,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        content_delta(" 团队已完成。"),
        message_end(FinishReason.END_TURN, input_tokens=4200, output_tokens=820, cost=_COST),
    ]

def _multi_agent_blocking_escalate_pending() -> list[SSEEvent]:
    """多 Agent：阻塞式求决策 — 进行中（卡片 live / 重载 dormant）。r1 阻塞挂起 emit
    ``escalation_required`` 后流到此为止（无 ``escalation_resolved`` / ``message_end``，镜像
    ``approval_paused`` 的「挂起态快照」）。关键断言：回合 ``status`` 仍为 ``running`` 且
    ``pendingInteraction`` 恒 None——阻塞升级【非 halting gate】，不把回合翻 paused（并行兄弟 r2 仍
    照常起跑），这正是它区别于 approval/ask_user/plan_review 的核心。r1 的升级 ``status="pending"``
    （即 live 应答卡；断连重载时同形为 dormant 记录）。"""
    agents, plan_runs = _blocking_escalate_team()
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来安排团队。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="选型并给建议",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        # 并行兄弟 r2 照常起跑——证明阻塞升级不挡其它 worker、不挂起整波。
        run_started("r2", "w2"),
        escalation_required("r1", "w1", escalation_id="esc1", question=_ESC_Q, assumption=_ESC_A),
    ]

def _multi_agent_blocking_escalate_multi() -> list[SSEEvent]:
    """多 Agent：阻塞式求决策 — 同一 worker 串行多次升级（多升级向量）。r1 先后撞到两个「只有用户
    能定」的关键岔路：第一次得到答复（resolved），续跑后第二次超时降级（timeout）。验证 ``escalations``
    可承载一个 run 的多条阻塞升级、且「找首个 pending」折叠在串行场景逐条对位结算——第二次 resolve
    命中的是当时唯一的 pending（esc2，esc1 已 resolved）。worker 串行 ⇒ 任一时刻至多一个 pending。"""
    agents, plan_runs = _blocking_escalate_team()
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来安排团队。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="选型并给建议",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        # 第一个关键岔路：阻塞挂起 → 用户答复 → resolved。
        escalation_required("r1", "w1", escalation_id="esc1", question=_ESC_Q, assumption=_ESC_A),
        escalation_resolved(
            "r1", "w1", escalation_id="esc1", status="resolved", answer="用 Postgres。"
        ),
        # 据首答续跑后又撞到第二个只有用户能定的点 → 再次阻塞挂起（此时 esc1 已结算，唯一 pending）。
        escalation_required(
            "r1",
            "w1",
            escalation_id="esc2",
            question="部署用 Docker 还是裸机？这关系到运维方案。",
            assumption="暂按 Docker 推进",
        ),
        # 第二次超时降级（answer 空）→ r1 回落到该假设续跑。
        escalation_resolved("r1", "w1", escalation_id="esc2", status="timeout", answer=""),
        run_output_delta("r1", "w1", "已确认 Postgres + Docker，完成选型调研"),
        run_completed(
            "r1",
            "w1",
            output_summary="完成选型调研（2 次升级）",
            duration_ms=1000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started("r2", "w2"),
        run_output_delta("r2", "w2", "基于选型给出建议"),
        run_completed(
            "r2",
            "w2",
            output_summary="完成建议",
            duration_ms=1000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        content_delta(" 团队已完成。"),
        message_end(FinishReason.END_TURN, input_tokens=4200, output_tokens=820, cost=_COST),
    ]

def _multi_agent_captain_context() -> list[SSEEvent]:
    """多 Agent：CEO + worker 都 emit ``run_context`` (上下文传递可视化)。captain（c1, kind=captain，
    在 ``run_plan`` 里声明为根 汇聚点）先于 run_plan emit ``run_started`` + ``run_context``（开场
    system/request）——它必须路由到 TURN 级 ``captainContext``，其图节点 ``receivedContext`` 恒空
    （「图节点复用同一份数据」，不双存）；worker（r1）的 ``run_context`` 照旧折到自身节点。

    通道⑤ 队员产物回流：worker 跑完后 captain 又 emit 一条 ``run_context``（channel=team_result，
    带来源角色/保真度），三端必须 APPEND 到 ``captainContext``——CEO 收到的上下文随团队产物增长，
    而非被覆盖。三端 fold + oracle pin them equal。"""
    agents = [
        {
            "id": "c1",
            "role": "CEO",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "w1",
            "role": "研究员",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    plan_runs = [
        {
            "id": "c1",
            "agent_id": "c1",
            "task": "统筹完成用户目标",
            "depends_on": [],
            "kind": "captain",
        },
        {
            "id": "r1",
            "agent_id": "w1",
            "task": "调研竞品定价",
            "depends_on": [],
            "parent_run_id": "c1",
        },
    ]
    return [
        message_start("m1", conversation_id=_CONV),
        run_started("c1", "c1", kind="captain"),
        run_context(
            "c1",
            "c1",
            [
                _ctx_block(
                    "system",
                    "CEO 系统提示（本回合实际遵循的系统指令）",
                    "你是 CEO，统筹团队完成用户目标。",
                ),
                _ctx_block("request", "原始用户请求", "调研竞品定价并给建议。"),
            ],
        ),
        content_delta("我来安排团队。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="竞品定价分析",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1", parent_run_id="c1"),
        run_context(
            "r1",
            "w1",
            [
                _ctx_block(
                    "request",
                    "原始用户请求（老板交给整个团队的目标，不一定全是你的活；你的具体职责见下方「你的任务」）",
                    "调研竞品定价并给建议。",
                ),
                _ctx_block("task", "你的任务", "调研竞品定价"),
            ],
        ),
        run_output_delta("r1", "w1", "竞品定价区间……"),
        run_completed(
            "r1",
            "w1",
            output_summary="完成调研",
            duration_ms=1000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        # 通道⑤: worker 跑完，captain（c1）回合内再 emit run_context 把队员产物回流到 CEO 气泡——
        # 三端 APPEND 到 captainContext（开场 system/request 之后），其 receivedContext 仍恒空。
        run_context(
            "c1",
            "c1",
            [
                _ctx_block(
                    "team_result",
                    "研究员（completed）",
                    "竞品定价区间 99–149/月，建议定价 129/月。",
                    source_role="研究员",
                    source_run_id="r1",
                    fidelity="pass_through",
                ),
            ],
        ),
        content_delta(" 已完成。"),
        run_completed(
            "c1",
            "c1",
            output_summary="汇总完成",
            duration_ms=2000,
            role="captain",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        message_end(FinishReason.END_TURN, input_tokens=4200, output_tokens=820, cost=_COST),
    ]


def _multi_agent_worker_output_reset() -> list[SSEEvent]:
    """多 Agent·交付前核验回炉 (finish_guard) 统一底线：worker done 轮结构缺陷
    （声明 json 却空体围栏）→ ``run_output_reset`` 清卡片已流式草稿 → 重写修正版。
    三端 fold + oracle 必须一致：清 agent output/outputChunks，reasoning 保留；
    无 ``content_reset``（CEO 气泡不受影响）。"""
    agents = [
        {
            "id": "w1",
            "role": "工程师",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    plan_runs = [{"id": "r1", "agent_id": "w1", "task": "起草结构化产出", "depends_on": []}]
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来安排队员起草。"),
        tool_use_start("dc1", "delegate", {"tasks": [{"role": "工程师"}]}),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="起草结构化产出",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        run_reasoning_delta("r1", "w1", "先起草 JSON 结构。"),
        run_output_delta("r1", "w1", "草稿：\n```json\n```"),
        run_output_reset("r1", "w1"),
        run_output_delta("r1", "w1", "修正后的产出：{\"status\":\"ok\"}"),
        run_completed(
            "r1",
            "w1",
            output_summary="修正后产出完成",
            duration_ms=1100,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        tool_use_end("dc1", "delegate", success=True, output="队员已修正产出。"),
        content_delta("队员已修正产出。"),
        message_end(FinishReason.END_TURN, input_tokens=2800, output_tokens=420, cost=_COST),
    ]


VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "multi_agent_delegate": ("多 Agent：委派 2 队员，runs 树 + 进度 + 总账", _multi_agent_delegate),
    "multi_agent_worker_tool": ("多 Agent：worker 工具调用 + run_tool_progress 实时态", _multi_agent_worker_tool),
    "multi_agent_worker_output_reset": (
        "多 Agent：交付前核验回炉 worker 对偶 run_output_reset 丢弃违规版 worker 草稿、保留思考、重写修正版",
        _multi_agent_worker_output_reset,
    ),
    "multi_agent_revision": ("多 Agent：定向唤回续写（revision 合成节点）", _multi_agent_revision),
    "multi_agent_plan_revised": ("多 Agent：自主再绑定「计划已调整」轻痕迹（plan_revised 折 bind/steer 到节点 revised）", _multi_agent_plan_revised),
    "multi_agent_multi_batch": ("多 Agent：同回合两批 delegate（合并 + 累计进度）", _multi_agent_multi_batch),
    "multi_agent_escalation": ("多 Agent：worker 升级实时可见（run_escalation 折到节点 escalations，非阻塞）", _multi_agent_escalation),
    "multi_agent_blocking_escalate": ("多 Agent：阻塞式求决策 答复路径（escalation_required→pending→resolved，回合不 paused）", _multi_agent_blocking_escalate),
    "multi_agent_blocking_escalate_timeout": ("多 Agent：阻塞式求决策 超时降级（escalation_resolved status=timeout，按假设续跑）", _multi_agent_blocking_escalate_timeout),
    "multi_agent_blocking_escalate_pending": ("多 Agent：阻塞式求决策 进行中（escalation_required 后挂起，回合仍 running、非 paused）", _multi_agent_blocking_escalate_pending),
    "multi_agent_blocking_escalate_multi": ("多 Agent：阻塞式求决策 同一 worker 串行多次升级（多升级 escalations[]，逐条结算）", _multi_agent_blocking_escalate_multi),
    "multi_agent_received_context": ("多 Agent：收到的上下文（run_context 三通道 + 依赖块溯源/保真度）", _multi_agent_received_context),
    "multi_agent_captain_context": ("多 Agent：CEO 收到的上下文路由回合级（captain 节点 receivedContext 恒空）+ worker 折到节点", _multi_agent_captain_context),
}
