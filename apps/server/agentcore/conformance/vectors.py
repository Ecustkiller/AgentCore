"""Curated conformance vectors — representative SSE event sequences (手机端落地设计 §六).

Built with the REAL event builders (:mod:`agentcore.runtime.events`) so every payload
shape matches production exactly; the export step projects each via the oracle into the
golden. Coverage is a棘轮: the core scenarios (single-agent text / tool / error /
citations, multi-agent delegate / worker-tool / debate / revision / multi-batch, the gate
pauses) + add a reproduction vector whenever a real protocol bug is found.

A vector is a ``list[SSEEvent]`` in emission order. Timestamps are assigned
deterministically at export (the projection ignores them), so the committed golden is
stable across runs.
"""

from __future__ import annotations

from collections.abc import Callable

from agentcore.runtime.events import (
    FinishReason,
    SSEEvent,
    approval_required,
    approval_resolved,
    citations_event,
    content_delta,
    content_reset,
    debate_result,
    debate_round,
    debate_round_started,
    error_event,
    escalation_raised,
    message_end,
    message_start,
    plan_review_required,
    plan_review_resolved,
    reasoning_delta,
    run_completed,
    run_context,
    run_output_delta,
    run_plan,
    run_started,
    run_tool_progress,
    tool_use_end,
    tool_use_start,
)

_CONV = "conv_demo"

# A representative priced cost (nano-USD) + usage, reused so goldens read realistically.
_USAGE = {"input": 1200, "output": 300, "reasoning": 120, "cache_hit": 800, "cache_miss": 400}
_COST = {"input": 240_000, "cached": 64_000, "output": 120_000, "total": 360_000, "currency": "USD"}


def _single_agent_text() -> list[SSEEvent]:
    return [
        message_start("m1", conversation_id=_CONV),
        reasoning_delta("先想一下。"),
        reasoning_delta("好的。"),
        content_delta("你好"),
        content_delta("，世界！"),
        message_end(FinishReason.END_TURN, input_tokens=1200, output_tokens=300, cost=_COST),
    ]


def _single_agent_tool() -> list[SSEEvent]:
    return [
        message_start("m1", conversation_id=_CONV),
        reasoning_delta("我先搜索。"),
        tool_use_start("tc1", "web_search", {"query": "AgentCore"}),
        tool_use_end("tc1", "web_search", success=True, output="找到 3 条结果。"),
        content_delta("根据搜索，"),
        content_delta("答案如下。"),
        message_end(FinishReason.END_TURN, input_tokens=1500, output_tokens=200, cost=_COST),
    ]


def _single_agent_error() -> list[SSEEvent]:
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("开始处理"),
        error_event("llm_error", "模型超时"),
    ]


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
        {"id": "w1", "role": "调研", "model_preference": "strong", "thinking": True, "reasoning_effort": "high"},
        {"id": "w2", "role": "执行", "model_preference": "fast", "thinking": True, "reasoning_effort": "high"},
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


def _single_agent_citations() -> list[SSEEvent]:
    return [
        message_start("m1", conversation_id=_CONV),
        reasoning_delta("先查资料。"),
        tool_use_start("tc1", "web_search", {"query": "AgentCore 架构"}),
        tool_use_end("tc1", "web_search", success=True, output="找到来源。"),
        content_delta("综合来看，"),
        content_delta("结论是 X。"),
        citations_event(
            [
                {"url": "https://a.example/x", "title": "来源 A", "snippet": "片段 A", "site": "a.example"},
                {"url": "https://b.example/y", "title": "来源 B", "snippet": "片段 B", "site": "b.example"},
            ]
        ),
        message_end(FinishReason.END_TURN, input_tokens=1800, output_tokens=260, cost=_COST),
    ]


def _single_agent_content_reset() -> list[SSEEvent]:
    """单聊·交付前核验回炉 (finish_guard)：CEO 直答先产出带越界角标的违规版正文（仅 1 条来源
    却引了 [2]，复刻真实事故「24 源却写 [25]」），done 轮轻层核验拦下 → content_reset 丢弃这
    一版 → 重写为只引真实来源 [1] 的修正版。三端 fold + oracle 必须一致处理 content_reset：清
    正文标量 + 弹掉 process 尾部连续 content 步，故最终 content/process 只含修正版（违规版不
    残留），尾部 tool 步保留。"""
    return [
        message_start("m1", conversation_id=_CONV),
        reasoning_delta("先查资料再作答。"),
        tool_use_start("tc1", "web_search", {"query": "建设工程价款优先权"}),
        tool_use_end("tc1", "web_search", success=True, output="找到 1 条来源。"),
        content_delta("依据 [1] 与 "),
        content_delta("[2] 可知……"),
        content_reset(),
        content_delta("依据 [1] "),
        content_delta("可知……"),
        citations_event(
            [
                {
                    "url": "https://a.example/x",
                    "title": "来源 A",
                    "snippet": "片段 A",
                    "site": "a.example",
                },
            ]
        ),
        message_end(FinishReason.END_TURN, input_tokens=1900, output_tokens=210, cost=_COST),
    ]


def _multi_agent_worker_tool() -> list[SSEEvent]:
    """多 Agent：worker 工具调用。``run_tool_progress`` 在 ProjectedTurn 上是唯一持久可观测
    （→ ``agent.toolProgress``）；worker 的 ``tool_use_start/end`` 落在被丢弃的 ``process`` /
    略去的 ``toolCalls``，故只验「一致地不泄漏」。末尾不发 ``message_end``：w2 停在「正在生成」
    快照，故其 ``toolProgress`` 可见。"""
    agents = [
        {"id": "w1", "role": "工程师", "model_preference": "strong", "thinking": True, "reasoning_effort": "high"},
        {"id": "w2", "role": "测试员", "model_preference": "fast", "thinking": True, "reasoning_effort": "high"},
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
        tool_use_start("tc1", "file_write", {"path": "a.py", "content": "print(1)"}),
        tool_use_end("tc1", "file_write", success=True, output="已写入"),
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


def _multi_agent_debate() -> list[SSEEvent]:
    """多 Agent：辩论（debate 工具 / 主持人驱动）。两段 run_plan(plan_type="debate")——先声明
    主持人节点（CEO 不进图，主持人 ``parent_run_id`` 引用 CEO captain run、节点不在图），再声明
    本轮正反辩手（携 stance/group/round，parent=主持人）；主持人走 run_started→run_completed
    完整生命周期（团队进度因此 3/3 正确收尾，不再有永久 pending 的编排节点），收场 debate_result
    承载【决策简报 + 交锋叙事线】双产物——三端 verbatim 折入 ProjectedTurn.debate，各方发言全文
    靠 rounds[*].sides[*].run_id 关联执行图辩手节点。"""
    cap, mod = "captain1", "debate_mod1"
    pro_run, con_run = f"{mod}_r1_pro", f"{mod}_r1_con"
    mod_agents = [
        {"id": mod, "role": "主持人", "model_preference": "strong",
         "thinking": True, "reasoning_effort": "high"},
    ]
    mod_runs = [
        {"id": mod, "agent_id": mod, "task": "主持正反辩论：是否采用方案 A",
         "depends_on": [], "parent_run_id": cap},
    ]
    debater_agents = [
        {"id": "d_pro", "role": "支持方", "model_preference": "strong",
         "thinking": True, "reasoning_effort": "high"},
        {"id": "d_con", "role": "反对方", "model_preference": "strong",
         "thinking": True, "reasoning_effort": "high"},
    ]
    debater_runs = [
        {"id": pro_run, "agent_id": "d_pro", "task": "论证支持采用方案 A",
         "depends_on": [], "parent_run_id": mod,
         "stance": "pro", "group": "debate:debate", "round": 1},
        {"id": con_run, "agent_id": "d_con", "task": "论证反对采用方案 A",
         "depends_on": [], "parent_run_id": mod,
         "stance": "con", "group": "debate:debate", "round": 1},
    ]
    debate_payload = {
        "form": "debate",
        "motion": "是否采用方案 A",
        "stop_reason": "converged",
        "narrative_first": False,
        "sides": [
            {"key": "pro", "name": "支持方", "stance": "支持采用方案 A", "is_subject": False},
            {"key": "con", "name": "反对方", "stance": "反对采用方案 A", "is_subject": False},
        ],
        "rounds": [
            {
                "round_no": 1,
                "focus": "方案 A 的收益与风险敞口",
                "summary": "支持方强调收益可量化，反对方指出缺乏风险兜底，焦点收敛到风险可控性。",
                "verdict": {
                    "real_clash": True,
                    "new_arguments": False,
                    "converged": True,
                    "stop_reason": "双方核心分歧已充分暴露，无新论据。",
                    "rationale": "争点收敛到风险可控性这一关键点，继续无新增信息。",
                },
                "sides": [
                    {"key": "pro", "name": "支持方", "run_id": pro_run, "ok": True},
                    {"key": "con", "name": "反对方", "run_id": con_run, "ok": True},
                ],
            },
        ],
        "brief": {
            "crux": "方案 A 的风险是否可控",
            "strongest_points": {"pro": "收益显著且可量化", "con": "风险敞口缺乏兜底"},
            "factual_disputes": ["历史故障率的数据口径不一致"],
            "value_disputes": ["增长优先 vs 稳健优先"],
            "leaning": "倾向有条件采用",
            "confidence": "medium",
            "recommendation": "先小流量灰度验证风险，再决定是否全量。",
            "open_questions": ["灰度的回滚阈值如何设定？"],
        },
    }
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我发起一场正反辩论来定夺。"),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="正反辩论：是否采用方案 A",
            agents=mod_agents,
            runs=mod_runs,
        ),
        run_started(mod, mod, parent_run_id=cap),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="",
            agents=debater_agents,
            runs=debater_runs,
        ),
        run_started(pro_run, "d_pro", parent_run_id=mod),
        run_output_delta(pro_run, "d_pro", "支持理由：收益可量化。"),
        run_completed(
            pro_run,
            "d_pro",
            output_summary="支持方陈述完成",
            duration_ms=800,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(con_run, "d_con", parent_run_id=mod),
        run_output_delta(con_run, "d_con", "反对理由：风险无兜底。"),
        run_completed(
            con_run,
            "d_con",
            output_summary="反对方陈述完成",
            duration_ms=850,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_completed(
            mod,
            mod,
            output_summary="方案 A 的风险是否可控",
            duration_ms=2000,
            role="主持人",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        debate_result(execution_id="exec1", moderator_run_id=mod, payload=debate_payload),
        message_end(FinishReason.END_TURN, input_tokens=3000, output_tokens=500, cost=_COST),
    ]


def _multi_agent_roundtable_rounds() -> list[SSEEvent]:
    """多 Agent：圆桌（roundtable）逐轮增量 + 中途取消。主持人逐轮 emit ``debate_round_started``
    （发言【前】给焦点）/ ``debate_round``（裁判 + 小结【后】给整轮）——三端折叠成 ProjectedTurn.
    debateRounds：第 1 轮完整（focus/summary/verdict/各方→辩手 run_id），第 2 轮仅开场
    （focus，verdict=None=进行中）后被取消。后续轮辩手是首轮的续写 revision（``revision=2`` +
    ``parent_run_id``，三端从 run_started 合成修订节点 + 继承原 agent 身份）。无 ``debate_result``
    （中途停）→ debate 恒 None，叙事线只在 debateRounds（这正是进行中实时叠加的覆盖点）。
    圆桌辩手节点携 ``group=debate:roundtable`` + ``round`` 但【无 stance】（多方非二元正反）。"""
    cap, mod = "captain1", "rt_mod1"
    r1a, r1b, r1c = f"{mod}_r1_a", f"{mod}_r1_b", f"{mod}_r1_c"
    r2a, r2b = f"{mod}_r2_a", f"{mod}_r2_b"
    mod_agents = [
        {"id": mod, "role": "主持人", "model_preference": "strong",
         "thinking": True, "reasoning_effort": "high"},
    ]
    mod_runs = [
        {"id": mod, "agent_id": mod, "task": "主持多方圆桌：AI 该如何治理",
         "depends_on": [], "parent_run_id": cap},
    ]
    debater_agents = [
        {"id": "rt_a", "role": "技术视角", "model_preference": "strong",
         "thinking": True, "reasoning_effort": "high"},
        {"id": "rt_b", "role": "监管视角", "model_preference": "strong",
         "thinking": True, "reasoning_effort": "high"},
        {"id": "rt_c", "role": "产业视角", "model_preference": "strong",
         "thinking": True, "reasoning_effort": "high"},
    ]
    debater_runs = [
        {"id": r1a, "agent_id": "rt_a", "task": "从技术视角谈 AI 治理",
         "depends_on": [], "parent_run_id": mod, "group": "debate:roundtable", "round": 1},
        {"id": r1b, "agent_id": "rt_b", "task": "从监管视角谈 AI 治理",
         "depends_on": [], "parent_run_id": mod, "group": "debate:roundtable", "round": 1},
        {"id": r1c, "agent_id": "rt_c", "task": "从产业视角谈 AI 治理",
         "depends_on": [], "parent_run_id": mod, "group": "debate:roundtable", "round": 1},
    ]
    round1_payload = {
        "round_no": 1,
        "focus": "AI 治理的第一性问题：风险从何而来",
        "summary": "技术方归因能力外溢，监管方强调问责缺位，产业方提醒落地成本，焦点铺成三条光谱。",
        "verdict": {
            "real_clash": True,
            "new_arguments": True,
            "converged": False,
            "stop_reason": "",
            "rationale": "三方视角已铺开但尚未交锋收敛，值得再探一轮。",
        },
        "sides": [
            {"key": "a", "name": "技术视角", "run_id": r1a, "ok": True},
            {"key": "b", "name": "监管视角", "run_id": r1b, "ok": True},
            {"key": "c", "name": "产业视角", "run_id": r1c, "ok": True},
        ],
    }
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来组织一场多方圆桌。"),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="多方圆桌：AI 该如何治理",
            agents=mod_agents,
            runs=mod_runs,
        ),
        run_started(mod, mod, parent_run_id=cap),
        # 第 1 轮：开场先报焦点（发言【前】），再声明本轮辩手 + 各方发言，收尾报整轮裁判 + 小结。
        debate_round_started(
            execution_id="exec1", moderator_run_id=mod, round_no=1, focus=round1_payload["focus"]
        ),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="",
            agents=debater_agents,
            runs=debater_runs,
        ),
        run_started(r1a, "rt_a", parent_run_id=mod),
        run_output_delta(r1a, "rt_a", "技术视角：能力外溢是根因。"),
        run_completed(r1a, "rt_a", output_summary="技术视角发言完成", duration_ms=800,
                      role="member", model="deepseek-v4-flash", usage=_USAGE, cost=_COST),
        run_started(r1b, "rt_b", parent_run_id=mod),
        run_output_delta(r1b, "rt_b", "监管视角：问责缺位才是关键。"),
        run_completed(r1b, "rt_b", output_summary="监管视角发言完成", duration_ms=820,
                      role="member", model="deepseek-v4-flash", usage=_USAGE, cost=_COST),
        run_started(r1c, "rt_c", parent_run_id=mod),
        run_output_delta(r1c, "rt_c", "产业视角：别忽视落地成本。"),
        run_completed(r1c, "rt_c", output_summary="产业视角发言完成", duration_ms=810,
                      role="member", model="deepseek-v4-flash", usage=_USAGE, cost=_COST),
        debate_round(execution_id="exec1", moderator_run_id=mod, payload=round1_payload),
        # 第 2 轮：开场报焦点（verdict 仍 None=进行中），辩手续写（revision=2）发言中被取消。
        debate_round_started(
            execution_id="exec1", moderator_run_id=mod, round_no=2,
            focus="第二轮：三方就『问责机制』正面交锋",
        ),
        run_started(r2a, "rt_a2", parent_run_id=r1a, revision=2),
        run_output_delta(r2a, "rt_a2", "技术视角续：问责需可观测性支撑。"),
        run_started(r2b, "rt_b2", parent_run_id=r1b, revision=2),
        run_output_delta(r2b, "rt_b2", "监管视角续：可观测性应立法强制。"),
        message_end(FinishReason.CANCELLED, input_tokens=4000, output_tokens=700, cost=_COST),
    ]


def _multi_agent_revision() -> list[SSEEvent]:
    """多 Agent：定向唤回续写 (乙 热修 P4)。修订 run(``revision=2`` + ``parent_run_id``)不在
    plan 里——三端都从其 ``run_started`` 帧合成出一个修订节点 + 继承原 agent 身份的新 agent。"""
    agents = [
        {"id": "w1", "role": "撰写员", "model_preference": "strong", "thinking": True, "reasoning_effort": "high"},
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


def _multi_agent_multi_batch() -> list[SSEEvent]:
    """多 Agent：同一回合两批 ``delegate``（同 ``execution_id``）。第二批合并进现有图（不重置），
    进度跨批累计（来自 run 状态、非每批 run_progress 计数器）。"""
    batch1_agents = [
        {"id": "w1", "role": "研究员", "model_preference": "strong", "thinking": True, "reasoning_effort": "high"},
    ]
    batch1_runs = [{"id": "r1", "agent_id": "w1", "task": "调研", "depends_on": []}]
    batch2_agents = [
        {"id": "w2", "role": "撰写员", "model_preference": "fast", "thinking": True, "reasoning_effort": "high"},
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


def _ctx_block(
    channel: str,
    heading: str,
    body: str,
    *,
    source_role: str = "",
    source_run_id: str = "",
    fidelity: str = "",
    truncated: bool = False,
    files: list[str] | None = None,
) -> dict:
    """One wire-shaped ContextBlock for a run_context vector — mirrors the executor's
    ``_context_block_payloads`` output exactly (``chars`` = body length, all keys present)
    so the golden matches what production emits."""
    return {
        "channel": channel,
        "heading": heading,
        "body": body,
        "chars": len(body),
        "truncated": truncated,
        "source_role": source_role,
        "source_run_id": source_run_id,
        "fidelity": fidelity,
        "files": list(files or []),
    }


def _multi_agent_received_context() -> list[SSEEvent]:
    """多 Agent：收到的上下文 (上下文传递可视化)。每个 worker 在 ``run_started`` 后 emit 一条
    ``run_context``——结构化承载它被喂进 LLM 的开场（单一源：用户看到的 == LLM 吃到的）。r1
    研究员收到【原始请求 + 团队位置 + 任务】三通道；r2 撰写员还多一条【前置结果】依赖块，带来源
    溯源（``source_role``/``source_run_id``）、保真度（``fidelity=pass_through``）与是否被预算截断
    （``truncated``）。三端 fold + oracle 必须把 blocks verbatim 折到对应 run 的 ``receivedContext``
    （conformance pins them equal）。"""
    agents = [
        {"id": "w1", "role": "研究员", "model_preference": "strong",
         "thinking": True, "reasoning_effort": "high"},
        {"id": "w2", "role": "撰写员", "model_preference": "fast",
         "thinking": True, "reasoning_effort": "high"},
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
        {"id": "w1", "role": "研究员", "model_preference": "strong",
         "thinking": True, "reasoning_effort": "high"},
        {"id": "w2", "role": "撰写员", "model_preference": "fast",
         "thinking": True, "reasoning_effort": "high"},
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


def _single_agent_captain_context() -> list[SSEEvent]:
    """单聊：CEO 收到的上下文 (上下文传递可视化, CEO 侧 通道①)。纯聊天回合无 run_plan，但 captain
    仍 emit ``run_started(kind=captain)`` + ``run_context``（system/history/request 三通道）。三端
    fold + oracle 必须把它路由到 TURN 级 ``captainContext``（CEO 是图上方的气泡，不是节点）——故
    ``runs`` 恒空、``process`` 照常累积，``captainContext`` 承载这三块。这正是方案 3 的关键：最高频的
    纯聊天回合也能看见 CEO 吃进了什么（决策②: system 默认隐藏是前端门控，不影响投影）。"""
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
                _ctx_block(
                    "history",
                    "对话历史（本回合之前的往来）",
                    "用户：你好\n\nCEO：你好，有什么可以帮你？",
                ),
                _ctx_block("request", "原始用户请求", "帮我把这段话润色一下。"),
            ],
        ),
        reasoning_delta("先理解用户的润色诉求。"),
        content_delta("润色后的版本如下：……"),
        run_completed(
            "c1",
            "c1",
            output_summary="完成润色",
            duration_ms=800,
            role="captain",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        message_end(FinishReason.END_TURN, input_tokens=1200, output_tokens=300, cost=_COST),
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
        {"id": "c1", "role": "CEO", "model_preference": "strong",
         "thinking": True, "reasoning_effort": "high"},
        {"id": "w1", "role": "研究员", "model_preference": "strong",
         "thinking": True, "reasoning_effort": "high"},
    ]
    plan_runs = [
        {"id": "c1", "agent_id": "c1", "task": "统筹完成用户目标",
         "depends_on": [], "kind": "captain"},
        {"id": "r1", "agent_id": "w1", "task": "调研竞品定价",
         "depends_on": [], "parent_run_id": "c1"},
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


# name → (description, builder). The export writes one golden JSON per entry.
VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "single_agent_text": ("单聊：思考+正文+总账，end_turn 完成", _single_agent_text),
    "single_agent_tool": ("单聊：思考→工具→正文（process 时间线）", _single_agent_tool),
    "single_agent_error": ("单聊：正文中途 error 事件 → failed", _single_agent_error),
    "multi_agent_delegate": ("多 Agent：委派 2 队员，runs 树 + 进度 + 总账", _multi_agent_delegate),
    "approval_paused": ("审批：approval_required 暂停（无 message_end）", _approval_paused),
    "approval_resolved_continue": ("审批：通过后继续到 end_turn", _approval_resolved_continue),
    "plan_review_paused": ("结构化挂起：plan_review_required 暂停", _plan_review_paused),
    "plan_review_resolved_continue": ("结构化挂起：放行后跑完下游", _plan_review_resolved_continue),
    "single_agent_citations": ("单聊：思考→工具→正文 + citations 来源卡", _single_agent_citations),
    "single_agent_content_reset": (
        "单聊：交付前核验回炉 (finish_guard) content_reset 丢弃违规版正文、重写修正版",
        _single_agent_content_reset,
    ),
    "multi_agent_worker_tool": ("多 Agent：worker 工具调用 + run_tool_progress 实时态", _multi_agent_worker_tool),
    "multi_agent_debate": (
        "多 Agent：辩论（debate 工具）主持人→辩手 + 决策简报/叙事线双产物",
        _multi_agent_debate,
    ),
    "multi_agent_roundtable_rounds": (
        "多 Agent：圆桌逐轮增量（debate_round_started/debate_round）+ 续写 revision + 中途取消",
        _multi_agent_roundtable_rounds,
    ),
    "multi_agent_revision": ("多 Agent：定向唤回续写（revision 合成节点）", _multi_agent_revision),
    "multi_agent_multi_batch": ("多 Agent：同回合两批 delegate（合并 + 累计进度）", _multi_agent_multi_batch),
    "multi_agent_escalation": (
        "多 Agent：worker 升级实时可见（run_escalation 折到节点 escalations，非阻塞）",
        _multi_agent_escalation,
    ),
    "multi_agent_received_context": (
        "多 Agent：收到的上下文（run_context 三通道 + 依赖块溯源/保真度）",
        _multi_agent_received_context,
    ),
    "single_agent_captain_context": (
        "单聊：CEO 收到的上下文（run_context kind=captain → 回合级 captainContext，system/history/request）",
        _single_agent_captain_context,
    ),
    "multi_agent_captain_context": (
        "多 Agent：CEO 收到的上下文路由回合级（captain 节点 receivedContext 恒空）+ worker 折到节点",
        _multi_agent_captain_context,
    ),
}
