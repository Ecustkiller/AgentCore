"""Curated conformance vectors — representative SSE event sequences (前端技术与架构 §十二).

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
    checkpoint_required,
    citations_event,
    content_delta,
    content_reset,
    debate_result,
    debate_round,
    debate_round_started,
    error_event,
    escalation_raised,
    escalation_required,
    escalation_resolved,
    message_end,
    message_start,
    plan_review_required,
    plan_review_resolved,
    plan_revised,
    question_posted,
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


def _single_agent_consult_memory() -> list[SSEEvent]:
    """单聊：CEO 翻开一条记忆主题笔记 (记忆文件夹化 §六 · consult_memory 渐进披露 可视化)。系统
    提示词的「记忆主题目录」只列主题名；CEO 判断「部署流程」与当前任务相关 → 调
    ``consult_memory(name=部署流程)`` 把该主题笔记**全文**拉回（``tool_use_end`` 携 ``display.topic``
    + ``result`` 正文），据此作答。consult_memory 是 CEO 召回原语、**不在** ORCHESTRATION_TOOLS
    丢弃集（那只含 delegate/debate），故它照常落一个 ``tool`` 步——三端 process fold + oracle 据
    ``display.topic`` 渲染成「查阅记忆：<主题>」卡片 + 可展开全文（镜像 consult_skill 的查阅卡）。"""
    note = (
        "## 部署流程\n"
        "- 前端：pnpm dev 起桌面壳\n"
        "- 服务端：uv run python -m agentcore\n"
        "- 数据库：本地 Postgres，迁移 alembic upgrade head\n"
    )
    return [
        message_start("m1", conversation_id=_CONV),
        reasoning_delta("这事和部署有关，先翻一下记忆里的部署流程。"),
        tool_use_start("tc1", "consult_memory", {"name": "部署流程"}),
        tool_use_end(
            "tc1",
            "consult_memory",
            success=True,
            output=note,
            display={"topic": "部署流程"},
        ),
        content_delta("按你记录的部署流程，"),
        content_delta("先 pnpm dev 起壳，再 uv run 起服务端即可。"),
        message_end(FinishReason.END_TURN, input_tokens=1400, output_tokens=180, cost=_COST),
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
        ),
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
                {
                    "url": "https://a.example/x",
                    "title": "来源 A",
                    "snippet": "片段 A",
                    "site": "a.example",
                },
                {
                    "url": "https://b.example/y",
                    "title": "来源 B",
                    "snippet": "片段 B",
                    "site": "b.example",
                },
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
        {
            "id": mod,
            "role": "主持人",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    mod_runs = [
        {
            "id": mod,
            "agent_id": mod,
            "task": "主持正反辩论：是否采用方案 A",
            "depends_on": [],
            "parent_run_id": cap,
        },
    ]
    debater_agents = [
        {
            "id": "d_pro",
            "role": "支持方",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "d_con",
            "role": "反对方",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    debater_runs = [
        {
            "id": pro_run,
            "agent_id": "d_pro",
            "task": "论证支持采用方案 A",
            "depends_on": [],
            "parent_run_id": mod,
            "stance": "pro",
            "group": "debate:debate",
            "round": 1,
        },
        {
            "id": con_run,
            "agent_id": "d_con",
            "task": "论证反对采用方案 A",
            "depends_on": [],
            "parent_run_id": mod,
            "stance": "con",
            "group": "debate:debate",
            "round": 1,
        },
    ]
    debate_payload = {
        "form": "debate",
        "motion": "是否采用方案 A",
        "stop_reason": "converged",
        "narrative_first": False,
        "sides": [
            # 真·多模型辩论：各方携显式 model（pro=豆包前缀路由 / con=无前缀默认 DeepSeek），
            # 锚定「正方=豆包 vs 反方=DeepSeek」展示链的跨端对齐（model 随 sides verbatim 折入）。
            {
                "key": "pro",
                "name": "支持方",
                "stance": "支持采用方案 A",
                "is_subject": False,
                "model": "doubao/doubao-seed-2-1-turbo-260628",
            },
            {
                "key": "con",
                "name": "反对方",
                "stance": "反对采用方案 A",
                "is_subject": False,
                "model": "deepseek-v4-pro",
            },
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
                "clashes": [
                    {
                        "from_key": "con",
                        "to_key": "pro",
                        "point": "收益可量化但未对冲风险敞口，量化口径回避了尾部风险。",
                    },
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
        {
            "id": mod,
            "role": "主持人",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    mod_runs = [
        {
            "id": mod,
            "agent_id": mod,
            "task": "主持多方圆桌：AI 该如何治理",
            "depends_on": [],
            "parent_run_id": cap,
        },
    ]
    debater_agents = [
        {
            "id": "rt_a",
            "role": "技术视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "rt_b",
            "role": "监管视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "rt_c",
            "role": "产业视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    debater_runs = [
        {
            "id": r1a,
            "agent_id": "rt_a",
            "task": "从技术视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
        {
            "id": r1b,
            "agent_id": "rt_b",
            "task": "从监管视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
        {
            "id": r1c,
            "agent_id": "rt_c",
            "task": "从产业视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
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
        "clashes": [
            {
                "from_key": "b",
                "to_key": "a",
                "point": "能力外溢说回避了问责主体，技术归因不能替代责任分配。",
            },
            {
                "from_key": "c",
                "to_key": "b",
                "point": "强问责会抬高合规成本，产业落地承受不起一刀切立法。",
            },
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
        run_completed(
            r1a,
            "rt_a",
            output_summary="技术视角发言完成",
            duration_ms=800,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(r1b, "rt_b", parent_run_id=mod),
        run_output_delta(r1b, "rt_b", "监管视角：问责缺位才是关键。"),
        run_completed(
            r1b,
            "rt_b",
            output_summary="监管视角发言完成",
            duration_ms=820,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(r1c, "rt_c", parent_run_id=mod),
        run_output_delta(r1c, "rt_c", "产业视角：别忽视落地成本。"),
        run_completed(
            r1c,
            "rt_c",
            output_summary="产业视角发言完成",
            duration_ms=810,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        debate_round(execution_id="exec1", moderator_run_id=mod, payload=round1_payload),
        # 第 2 轮：开场报焦点（verdict 仍 None=进行中），辩手续写（revision=2）发言中被取消。
        debate_round_started(
            execution_id="exec1",
            moderator_run_id=mod,
            round_no=2,
            focus="第二轮：三方就『问责机制』正面交锋",
        ),
        run_started(r2a, "rt_a2", parent_run_id=r1a, revision=2),
        run_output_delta(r2a, "rt_a2", "技术视角续：问责需可观测性支撑。"),
        run_started(r2b, "rt_b2", parent_run_id=r1b, revision=2),
        run_output_delta(r2b, "rt_b2", "监管视角续：可观测性应立法强制。"),
        message_end(FinishReason.CANCELLED, input_tokens=4000, output_tokens=700, cost=_COST),
    ]


def _multi_agent_red_team() -> list[SSEEvent]:
    """多 Agent：红队审查【收场】(red_team settled)。被审【方案方】(is_subject=true) 承受红队的
    单向攻击并回应修补，主持人逐轮挖风险、判是否挖尽，收场 debate_result(form="red_team") 承载
    【风险看板 + 交锋叙事线】双产物：红队成员的 strongest_points = 最尖锐风险、方案方的 = 其抗辩，
    recommendation = 加固建议。三名红队成员（安全 / 合规 / 运维）携 brief.risk_severities
    = high/medium/low，验【风险看板】按严重度分级 + 总览计数（高危 1 · 中危 1 · 低危 1）+ 由危到轻
    排序；其余红队简报骨架（加固建议 / 方案方回应 / 还需厘清）与正反辩论同一套主次（结论先行 +
    价值之争提为「需你拍板」+ 事实分歧/待解降级），逐轮走风险看板研判。"""
    cap, mod = "captain1", "redteam_mod1"
    subj_run = f"{mod}_r1_subject"
    red1_run = f"{mod}_r1_red1"
    red2_run = f"{mod}_r1_red2"
    red3_run = f"{mod}_r1_red3"
    mod_agents = [
        {
            "id": mod,
            "role": "主持人",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    mod_runs = [
        {
            "id": mod,
            "agent_id": mod,
            "task": "主持红队审查：压测「自建鉴权服务」方案",
            "depends_on": [],
            "parent_run_id": cap,
        },
    ]
    debater_agents = [
        {
            "id": "d_subject",
            "role": "方案方",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "d_red1",
            "role": "安全红队",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "d_red2",
            "role": "合规红队",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "d_red3",
            "role": "运维红队",
            "model_preference": "fast",
            "thinking": False,
            "reasoning_effort": "low",
        },
    ]
    debater_runs = [
        {
            "id": subj_run,
            "agent_id": "d_subject",
            "task": "为「自建鉴权服务」方案抗辩并修补",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:red_team",
            "round": 1,
        },
        {
            "id": red1_run,
            "agent_id": "d_red1",
            "task": "挖「自建鉴权服务」方案的安全风险",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:red_team",
            "round": 1,
        },
        {
            "id": red2_run,
            "agent_id": "d_red2",
            "task": "审「自建鉴权服务」方案的合规缺口",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:red_team",
            "round": 1,
        },
        {
            "id": red3_run,
            "agent_id": "d_red3",
            "task": "查「自建鉴权服务」方案的运维隐患",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:red_team",
            "round": 1,
        },
    ]
    debate_payload = {
        "form": "red_team",
        "motion": "压测「自建鉴权服务」方案的稳健性",
        "stop_reason": "red_team_exhausted",
        "narrative_first": False,
        # 红队=被审方案方(is_subject) + ≥1 红队；语义名对称同风格（方案方 / 安全红队），不混入模型名。
        "sides": [
            {
                "key": "subject",
                "name": "方案方",
                "stance": "自建鉴权可控且省授权成本",
                "is_subject": True,
                "model": "",
            },
            {
                "key": "red1",
                "name": "安全红队",
                "stance": "自建鉴权的攻击面与凭证安全",
                "is_subject": False,
                "model": "",
            },
            {
                "key": "red2",
                "name": "合规红队",
                "stance": "自建鉴权的合规与审计缺口",
                "is_subject": False,
                "model": "",
            },
            {
                "key": "red3",
                "name": "运维红队",
                "stance": "自建鉴权的长期运维负担",
                "is_subject": False,
                "model": "",
            },
        ],
        "rounds": [
            {
                "round_no": 1,
                "focus": "凭证存储与会话固定的攻击面",
                "summary": "红队指出自建鉴权易踩 token 泄漏与会话固定，方案方承认需补固化与轮换。",
                "verdict": {
                    "real_clash": True,
                    "new_arguments": True,
                    "converged": False,
                    "stop_reason": "",
                    "rationale": "红队挖出有效风险，方案方部分采纳，仍有未覆盖项。",
                },
                "sides": [
                    {"key": "subject", "name": "方案方", "run_id": subj_run, "ok": True},
                    {"key": "red1", "name": "安全红队", "run_id": red1_run, "ok": True},
                    {"key": "red2", "name": "合规红队", "run_id": red2_run, "ok": True},
                    {"key": "red3", "name": "运维红队", "run_id": red3_run, "ok": True},
                ],
                "clashes": [
                    {
                        "from_key": "red1",
                        "to_key": "subject",
                        "point": "未做 token 轮换与设备绑定，刷新令牌一旦泄漏即长期可用。",
                    },
                    {
                        "from_key": "red2",
                        "to_key": "subject",
                        "point": "缺审计日志留存与访问追溯，过不了等保与合规审查。",
                    },
                ],
            },
        ],
        "brief": {
            "crux": "自建鉴权的攻击面是否可控、加固成本是否低于外采",
            "strongest_points": {
                "red1": "刷新令牌缺轮换与设备绑定，泄漏即长期可用，是最尖锐风险。",
                "red2": "无审计日志留存与访问追溯，过不了等保三级与合规审查。",
                "red3": "密钥轮换 / 应急吊销全靠人肉，长期运维负担与误操作风险偏高。",
                "subject": "可引入短时访问令牌 + 轮换刷新令牌，把风险降到与外采相当。",
            },
            # 红队风险严重度（驱动前端风险看板分级 + 总览计数）：安全=高危、合规=中危、运维=低危；
            # 被审方案方(subject)不评级。
            "risk_severities": {
                "red1": "high",
                "red2": "medium",
                "red3": "low",
            },
            "factual_disputes": ["自建 vs 外采的真实合规改造工作量缺乏一致口径"],
            "value_disputes": ["把鉴权握在自己手里的掌控感 vs 外采省心"],
            "leaning": "有条件通过：先补 3 项加固再上线",
            "confidence": "medium",
            "recommendation": "上线前必须：① 刷新令牌轮换 + 设备绑定 ② 登录限速与异常告警 ③ 第三方渗透测试。",
            "open_questions": ["密钥轮换的运维归属谁？"],
        },
    }
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我发起一场红队审查来压测这个方案。"),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="红队审查：压测「自建鉴权服务」方案",
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
        run_started(subj_run, "d_subject", parent_run_id=mod),
        run_output_delta(subj_run, "d_subject", "方案方：自建鉴权可控、省授权成本。"),
        run_completed(
            subj_run,
            "d_subject",
            output_summary="方案方抗辩完成",
            duration_ms=820,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(red1_run, "d_red1", parent_run_id=mod),
        run_output_delta(red1_run, "d_red1", "安全红队：刷新令牌缺轮换，泄漏即长期可用。"),
        run_completed(
            red1_run,
            "d_red1",
            output_summary="安全红队挖掘完成",
            duration_ms=860,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(red2_run, "d_red2", parent_run_id=mod),
        run_output_delta(red2_run, "d_red2", "合规红队：缺审计日志留存，过不了等保合规。"),
        run_completed(
            red2_run,
            "d_red2",
            output_summary="合规红队挖掘完成",
            duration_ms=780,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(red3_run, "d_red3", parent_run_id=mod),
        run_output_delta(red3_run, "d_red3", "运维红队：密钥轮换全靠人肉，长期负担偏高。"),
        run_completed(
            red3_run,
            "d_red3",
            output_summary="运维红队挖掘完成",
            duration_ms=540,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_completed(
            mod,
            mod,
            output_summary="自建鉴权的攻击面是否可控",
            duration_ms=2100,
            role="主持人",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        debate_result(execution_id="exec1", moderator_run_id=mod, payload=debate_payload),
        message_end(FinishReason.END_TURN, input_tokens=3200, output_tokens=560, cost=_COST),
    ]


def _multi_agent_legal_war_room() -> list[SSEEvent]:
    """多 Agent：法律「答辩状作战室」端到端（hero · 法律垂直场景设计.md §6.3 M3 补盲 fixture）。
    复用现有事件类型**组合**出法律 hero 的玻璃箱全流程——给它一个常驻离线预览场景 + CI 渲染冒烟门，
    **不新增事件类型 → fold 不碰**（守协议边界）。流程与 M2 实测形态一致：① CEO
    `consult_skill(legal_answer_brief)` 翻作战室打法；② `delegate` 起草律师出 `答辩状初稿.md`
    （worker 内 `file_write`）；③ `debate(form=red_team)` 让**原告红队**单向压测我方答辩
    （`defense` is_subject vs 程序 / 实体红队），收场 `debate_result` 承「风险看板 + 加固建议 +
    我方回应」双产物，挖出 3 个攻击点（送达举证 / 质量异议具体性 / 沉默推定）；④ `delegate` 核验
    律师 `web_search` + 落 `法条核验报告.md`（带**出处** + `[待核验]`）；⑤ 终稿前 `checkpoint`
    人审闸门**暂停**（status=paused、pendingInteraction=checkpoint），把攻防 / 核验结论摊给律师
    拍板再收口。核验出处 v0 走核验报告 + worker 工具日志（非 citations 来源卡，来源卡接入属后续
    打磨），故本向量如实**不发** citations_event、亦不 message_end（停在人审闸门）。"""
    cap = "captain1"
    mod = "warroom_mod1"
    r_draft, w_draft = "r_draft", "w_draft"
    r_verify, w_verify = "r_verify", "w_verify"
    subj_run = f"{mod}_r1_defense"
    redp_run = f"{mod}_r1_redproc"
    reds_run = f"{mod}_r1_redsubst"

    skill_guidance = (
        "## 答辩状作战室\n"
        "1. 解析对方起诉状 + 我方事实 → 逐项答辩（程序抗辩 + 实体抗辩 + 质证 + 法律依据）。\n"
        "2. delegate 起草，debate(red_team, is_subject=我方答辩) 让原告红队单向压测，再逐点加固。\n"
        "3. delegate 核验逐条法条 / 时效，未核验不得引用、标 [待核验]；终稿标法域 + 免责 + 人审闸门。\n"
    )
    draft_md = (
        "# 民事答辩状（初稿）\n"
        "## 程序抗辩\n- 对原告送达与举证提出异议。\n"
        "## 实体抗辩\n- 质量异议函已发，违约责任不成立。\n"
        "## 法律依据\n- 《民法典》合同编相关条款（待核验）。\n"
    )
    verify_md = (
        "# 法条核验报告\n"
        "| 引用 | 现行有效性 | 出处 | 结论 |\n"
        "|---|---|---|---|\n"
        "| 违约金超损失 30% 可调减 | 现行有效 | 《民法典合同编通则若干问题的解释》第 65 条 | ✅ 已核验 |\n"
        "| 质量异议合理期限 | 现行有效 | 《民法典》第 621 条 | ✅ 已核验 |\n"
        "| 送达推定到达规则 | 待确认条款 | web 摘要不足 | ⚠️ [待核验]（转人工 / 库核） |\n"
    )

    draft_agents = [
        {
            "id": w_draft,
            "role": "起草律师",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    draft_runs = [{"id": r_draft, "agent_id": w_draft, "task": "起草答辩状初稿", "depends_on": []}]
    verify_agents = [
        {
            "id": w_verify,
            "role": "核验律师",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    verify_runs = [
        {"id": r_verify, "agent_id": w_verify, "task": "逐条核验法条与时效", "depends_on": []}
    ]
    mod_agents = [
        {
            "id": mod,
            "role": "主持人",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    mod_runs = [
        {
            "id": mod,
            "agent_id": mod,
            "task": "主持红队审查：原告视角压测我方答辩",
            "depends_on": [],
            "parent_run_id": cap,
        },
    ]
    debater_agents = [
        {
            "id": "d_defense",
            "role": "我方答辩",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "d_red_proc",
            "role": "程序红队",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "d_red_subst",
            "role": "实体红队",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    debater_runs = [
        {
            "id": subj_run,
            "agent_id": "d_defense",
            "task": "为我方答辩抗辩并加固",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:red_team",
            "round": 1,
        },
        {
            "id": redp_run,
            "agent_id": "d_red_proc",
            "task": "以原告视角挖程序 / 送达漏洞",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:red_team",
            "round": 1,
        },
        {
            "id": reds_run,
            "agent_id": "d_red_subst",
            "task": "以原告视角挖实体抗辩漏洞",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:red_team",
            "round": 1,
        },
    ]
    debate_payload = {
        "form": "red_team",
        "motion": "以原告视角压测我方《民事答辩状》的稳健性",
        "stop_reason": "red_team_exhausted",
        "narrative_first": False,
        "sides": [
            {
                "key": "defense",
                "name": "我方答辩",
                "stance": "逐项抗辩成立、无需担责",
                "is_subject": True,
                "model": "",
            },
            {
                "key": "red_proc",
                "name": "程序红队（原告）",
                "stance": "程序与送达举证存在硬伤",
                "is_subject": False,
                "model": "",
            },
            {
                "key": "red_subst",
                "name": "实体红队（原告）",
                "stance": "实体抗辩不成立",
                "is_subject": False,
                "model": "",
            },
        ],
        "rounds": [
            {
                "round_no": 1,
                "focus": "送达举证 / 质量异议具体性 / 沉默推定 三点攻防",
                "summary": "原告红队挖出送达签收链缺失、异议函笼统、对部分诉请沉默三点；我方补证据并逐点否认加固。",
                "verdict": {
                    "real_clash": True,
                    "new_arguments": True,
                    "converged": True,
                    "stop_reason": "red_team_exhausted",
                    "rationale": "三点攻击已被逐点回应 / 加固，无新增有效攻击。",
                },
                "sides": [
                    {"key": "defense", "name": "我方答辩", "run_id": subj_run, "ok": True},
                    {"key": "red_proc", "name": "程序红队（原告）", "run_id": redp_run, "ok": True},
                    {"key": "red_subst", "name": "实体红队（原告）", "run_id": reds_run, "ok": True},
                ],
                "clashes": [
                    {
                        "from_key": "red_proc",
                        "to_key": "defense",
                        "point": "到达举证缺签收链，送达争议规则对我方不利。",
                    },
                    {
                        "from_key": "red_subst",
                        "to_key": "defense",
                        "point": "质量异议函笼统、未指向批次 / 标准；对部分诉请沉默易被推定认可。",
                    },
                ],
            },
        ],
        "brief": {
            "crux": "我方答辩能否扛住原告对『送达举证 + 质量异议具体性 + 沉默推定』三点的攻击",
            "strongest_points": {
                "red_proc": "到达举证缺签收链，按送达争议规则我方不利，是最尖锐风险。",
                "red_subst": "质量异议函表述笼统、未指向具体批次 / 标准，难达异议成立要件；对原告主张沉默处易被推定认可。",
                "defense": "已补送达回执 + 异议函逐条对应批次，并就沉默项明确否认。",
            },
            "risk_severities": {
                "red_proc": "high",
                "red_subst": "medium",
            },
            "factual_disputes": ["质量异议函是否在合理期限内送达原告口径不一"],
            "value_disputes": ["以程序抗辩拖延 vs 实体一次性了结的策略取舍"],
            "leaning": "有条件成立：补强送达证据 + 异议函具体化 + 逐项否认后可扛住",
            "confidence": "medium",
            "recommendation": "终稿前必须：① 补送达签收链证据 ② 异议函按批次 / 标准逐条具体化 ③ 对原告每项主张明确否认，杜绝沉默推定。",
            "open_questions": ["违约金调减的请求权基础按哪条主张？"],
        },
    }
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我先翻一下「答辩状作战室」的打法。"),
        tool_use_start("cs1", "consult_skill", {"name": "legal_answer_brief"}),
        tool_use_end(
            "cs1",
            "consult_skill",
            success=True,
            output=skill_guidance,
            display={
                "skill_name": "legal_answer_brief",
                "summary": "答辩状要素结构 + 对方律师作战室编排 + 反幻觉硬约束",
            },
        ),
        content_delta("按作战室打法组队：先起草，再让原告红队压一遍，核验法条，最后请你拍板。"),
        # ① delegate 起草律师 → 答辩状初稿.md（worker 内 file_write）
        tool_use_start("dc1", "delegate", {"tasks": [{"role": "起草律师"}]}),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="起草答辩状初稿",
            agents=draft_agents,
            runs=draft_runs,
        ),
        run_started(r_draft, w_draft),
        run_tool_progress(r_draft, w_draft, "file_write", len(draft_md)),
        tool_use_start(
            "fw1", "file_write", {"path": "答辩状初稿.md", "content": draft_md}, run_id=r_draft
        ),
        tool_use_end("fw1", "file_write", success=True, output="已写入", run_id=r_draft),
        run_output_delta(r_draft, w_draft, "答辩状初稿就绪：程序抗辩 + 实体抗辩 + 质证 + 法律依据。"),
        run_completed(
            r_draft,
            w_draft,
            output_summary="起草完成：答辩状初稿.md",
            duration_ms=1600,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        tool_use_end("dc1", "delegate", success=True, output="起草完成：答辩状初稿.md"),
        # ② debate(red_team)：原告红队单向压测我方答辩（hero）
        content_delta("现在让原告红队来压测我方答辩。"),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="红队审查：原告视角压测我方《民事答辩状》",
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
        run_started(subj_run, "d_defense", parent_run_id=mod),
        run_output_delta(
            subj_run, "d_defense", "我方：已补送达回执、异议函逐条对应批次，并就沉默项明确否认。"
        ),
        run_completed(
            subj_run,
            "d_defense",
            output_summary="我方抗辩 + 加固完成",
            duration_ms=900,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(redp_run, "d_red_proc", parent_run_id=mod),
        run_output_delta(redp_run, "d_red_proc", "程序红队：到达举证缺签收链，送达争议对我方不利。"),
        run_completed(
            redp_run,
            "d_red_proc",
            output_summary="程序红队挖掘完成",
            duration_ms=840,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(reds_run, "d_red_subst", parent_run_id=mod),
        run_output_delta(
            reds_run, "d_red_subst", "实体红队：质量异议函笼统、对部分诉请沉默易被推定认可。"
        ),
        run_completed(
            reds_run,
            "d_red_subst",
            output_summary="实体红队挖掘完成",
            duration_ms=860,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_completed(
            mod,
            mod,
            output_summary="原告红队三点攻击已被逐点回应",
            duration_ms=2200,
            role="主持人",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        debate_result(execution_id="exec1", moderator_run_id=mod, payload=debate_payload),
        # ③ delegate 核验律师 → web_search + 法条核验报告.md（出处 + [待核验]）
        content_delta("再逐条核验法条与时效。"),
        tool_use_start("dc2", "delegate", {"tasks": [{"role": "核验律师"}]}),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="逐条核验法条 / 时效",
            agents=verify_agents,
            runs=verify_runs,
        ),
        run_started(r_verify, w_verify),
        run_tool_progress(r_verify, w_verify, "web_search", 3),
        tool_use_start(
            "ws1",
            "web_search",
            {"query": "民法典合同编通则解释 违约金 调减"},
            run_id=r_verify,
        ),
        tool_use_end(
            "ws1",
            "web_search",
            success=True,
            output="命中：合同编通则解释第 65 条；送达规则未取到权威原文。",
            run_id=r_verify,
        ),
        run_tool_progress(r_verify, w_verify, "file_write", len(verify_md)),
        tool_use_start(
            "fw2", "file_write", {"path": "法条核验报告.md", "content": verify_md}, run_id=r_verify
        ),
        tool_use_end("fw2", "file_write", success=True, output="已写入", run_id=r_verify),
        run_output_delta(
            r_verify,
            w_verify,
            "核验完成：违约金调减引《合同编通则解释》第 65 条；送达规则标 [待核验]。",
        ),
        run_completed(
            r_verify,
            w_verify,
            output_summary="核验完成：法条核验报告.md",
            duration_ms=2000,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        tool_use_end(
            "dc2", "delegate", success=True, output="核验完成：法条核验报告.md（1 处 [待核验]）"
        ),
        # ④ 终稿前人审闸门 → 暂停（status=paused，结论摊给律师拍板再收口）
        content_delta(
            "终稿前请你过一下：红队 3 个攻击点已逐点加固，法条已核验，有 1 处待人工确认。"
        ),
        checkpoint_required(
            checkpoint_id="cp1",
            conversation_id=_CONV,
            question="是否采纳终稿并提交？（含 1 处 [待核验] 法条）",
            context="原告红队已挖尽收敛，核验报告与答辩状初稿见工作区；终稿将标注法域 + 免责。",
        ),
    ]


def _multi_agent_roundtable_settled() -> list[SSEEvent]:
    """多 Agent：圆桌探讨【收场】(roundtable settled)。3 视角多边碰撞后主持人收场，debate_result
    (form="roundtable") 承载【观点光谱 + 交锋叙事线】双产物：strongest_points 按 side.key 给各视角
    核心主张（光谱），leaning=综合观察、recommendation=建议。探讨无单一裁决/赢家。验「观点光谱」英雄
    区（置顶 glanceable）+ 叙事后简报小结（共同焦点一行 / 需你拍板 / 还需厘清），与正反/红队同一套
    次级信息主次（去掉旧版等权 DisputeSection，三形态一致）。圆桌辩手无 stance（多方非二元正反）。"""
    cap, mod = "captain1", "rts_mod1"
    ra, rb, rc = f"{mod}_r1_a", f"{mod}_r1_b", f"{mod}_r1_c"
    mod_agents = [
        {
            "id": mod,
            "role": "主持人",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    mod_runs = [
        {
            "id": mod,
            "agent_id": mod,
            "task": "主持多方圆桌：AI 该如何治理",
            "depends_on": [],
            "parent_run_id": cap,
        },
    ]
    debater_agents = [
        {
            "id": "rt_a",
            "role": "技术视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "rt_b",
            "role": "监管视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "rt_c",
            "role": "产业视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    debater_runs = [
        {
            "id": ra,
            "agent_id": "rt_a",
            "task": "从技术视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
        {
            "id": rb,
            "agent_id": "rt_b",
            "task": "从监管视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
        {
            "id": rc,
            "agent_id": "rt_c",
            "task": "从产业视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
    ]
    debate_payload = {
        "form": "roundtable",
        "motion": "AI 该如何治理",
        "stop_reason": "converged",
        "narrative_first": False,
        # 圆桌≥3 视角，语义名对称同风格（技术 / 监管 / 产业视角）；无 is_subject、无 stance。
        "sides": [
            {
                "key": "a",
                "name": "技术视角",
                "stance": "风险源于能力外溢，治理应内建可观测与熔断",
                "is_subject": False,
                "model": "",
            },
            {
                "key": "b",
                "name": "监管视角",
                "stance": "缺的是问责主体，须以立法明确责任归属",
                "is_subject": False,
                "model": "",
            },
            {
                "key": "c",
                "name": "产业视角",
                "stance": "一刀切立法抬高合规成本，应分级分场景落地",
                "is_subject": False,
                "model": "",
            },
        ],
        "rounds": [
            {
                "round_no": 1,
                "focus": "AI 治理的主轴：先管能力还是先管问责",
                "summary": "技术方归因能力外溢，监管方强调问责缺位，产业方提醒落地成本，三方收敛到分级治理。",
                "verdict": {
                    "real_clash": True,
                    "new_arguments": False,
                    "converged": True,
                    "stop_reason": "三方视角已充分铺开并就分级治理形成交集。",
                    "rationale": "光谱铺满且出现交集，继续无新增视角。",
                },
                "sides": [
                    {"key": "a", "name": "技术视角", "run_id": ra, "ok": True},
                    {"key": "b", "name": "监管视角", "run_id": rb, "ok": True},
                    {"key": "c", "name": "产业视角", "run_id": rc, "ok": True},
                ],
                "clashes": [
                    {
                        "from_key": "b",
                        "to_key": "a",
                        "point": "能力外溢说回避了问责主体，技术归因不能替代责任分配。",
                    },
                    {
                        "from_key": "c",
                        "to_key": "b",
                        "point": "强问责会抬高合规成本，产业落地承受不起一刀切立法。",
                    },
                ],
            },
        ],
        "brief": {
            "crux": "AI 治理的主轴：先管能力还是先管问责",
            "strongest_points": {
                "a": "风险源于能力外溢，治理应内建可观测与熔断。",
                "b": "缺的是问责主体，须以立法明确责任归属。",
                "c": "一刀切立法抬高合规成本，应分级分场景落地。",
            },
            "factual_disputes": ["现有事故里『能力外溢』与『问责缺位』各占多少缺一致数据"],
            "value_disputes": ["创新速度优先 vs 风险兜底优先"],
            "leaning": "三方共识：分级治理 + 可观测先行，问责随之立法",
            "confidence": "medium",
            "recommendation": "按能力分级，先强制高风险场景的可观测与熔断，再补问责立法。",
            "open_questions": ["谁来认定与维护『高风险场景』清单？"],
        },
    }
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来组织一场多方圆桌并收场。"),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="多方圆桌：AI 该如何治理",
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
        run_started(ra, "rt_a", parent_run_id=mod),
        run_output_delta(ra, "rt_a", "技术视角：能力外溢是根因，需可观测与熔断。"),
        run_completed(
            ra,
            "rt_a",
            output_summary="技术视角发言完成",
            duration_ms=800,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(rb, "rt_b", parent_run_id=mod),
        run_output_delta(rb, "rt_b", "监管视角：问责缺位才是关键，须立法明确。"),
        run_completed(
            rb,
            "rt_b",
            output_summary="监管视角发言完成",
            duration_ms=820,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(rc, "rt_c", parent_run_id=mod),
        run_output_delta(rc, "rt_c", "产业视角：别忽视落地成本，应分级分场景。"),
        run_completed(
            rc,
            "rt_c",
            output_summary="产业视角发言完成",
            duration_ms=810,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_completed(
            mod,
            mod,
            output_summary="AI 治理的主轴：先管能力还是先管问责",
            duration_ms=2200,
            role="主持人",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        debate_result(execution_id="exec1", moderator_run_id=mod, payload=debate_payload),
        message_end(FinishReason.END_TURN, input_tokens=3400, output_tokens=600, cost=_COST),
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


# 阻塞式求决策 (escalate blocking=true) 三向量共用的队伍 + 问题/假设文案，保证三条路径
# （答复 / 超时降级 / 进行中）只在「升级如何收场」上分叉，其余完全一致。
_ESC_Q = "数据库选 Postgres 还是 MySQL？这关系到后续所有选型，且猜错基本要整段返工。"
_ESC_A = "暂按 Postgres 推进"


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


# name → (description, builder). The export writes one golden JSON per entry.
VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "single_agent_text": ("单聊：思考+正文+总账，end_turn 完成", _single_agent_text),
    "single_agent_tool": ("单聊：思考→工具→正文（process 时间线）", _single_agent_tool),
    "single_agent_consult_memory": (
        "单聊：CEO 翻开记忆主题笔记（consult_memory → 查阅记忆卡片 + 全文）",
        _single_agent_consult_memory,
    ),
    "single_agent_error": ("单聊：正文中途 error 事件 → failed", _single_agent_error),
    "multi_agent_delegate": ("多 Agent：委派 2 队员，runs 树 + 进度 + 总账", _multi_agent_delegate),
    "approval_paused": ("审批：approval_required 暂停（无 message_end）", _approval_paused),
    "approval_resolved_continue": ("审批：通过后继续到 end_turn", _approval_resolved_continue),
    "plan_review_paused": ("结构化挂起：plan_review_required 暂停", _plan_review_paused),
    "plan_review_resolved_continue": ("结构化挂起：放行后跑完下游", _plan_review_resolved_continue),
    "single_agent_checkpoint": (
        "单聊：检查点 ask_user(blocking) 在时间线原位落 checkpoint 标记 + 暂停",
        _single_agent_checkpoint,
    ),
    "single_agent_non_blocking_ask": (
        "单聊：非阻塞发问 question_posted 在时间线原位落 ask 标记、回合照常收尾",
        _single_agent_non_blocking_ask,
    ),
    "single_agent_citations": ("单聊：思考→工具→正文 + citations 来源卡", _single_agent_citations),
    "single_agent_content_reset": (
        "单聊：交付前核验回炉 (finish_guard) content_reset 丢弃违规版正文、重写修正版",
        _single_agent_content_reset,
    ),
    "multi_agent_worker_tool": (
        "多 Agent：worker 工具调用 + run_tool_progress 实时态",
        _multi_agent_worker_tool,
    ),
    "multi_agent_debate": (
        "多 Agent：辩论（debate 工具）主持人→辩手 + 决策简报/叙事线双产物",
        _multi_agent_debate,
    ),
    "multi_agent_roundtable_rounds": (
        "多 Agent：圆桌逐轮增量（debate_round_started/debate_round）+ 续写 revision + 中途取消",
        _multi_agent_roundtable_rounds,
    ),
    "multi_agent_red_team": (
        "多 Agent：红队审查收场（form=red_team）风险看板 + 加固建议 + 方案方回应双产物",
        _multi_agent_red_team,
    ),
    "multi_agent_legal_war_room": (
        "法律「答辩状作战室」端到端 hero：consult_skill→delegate 起草→debate(red_team) 原告红队压测"
        "→delegate 核验(法条核验报告 + [待核验])→人审闸门 checkpoint 暂停",
        _multi_agent_legal_war_room,
    ),
    "multi_agent_roundtable_settled": (
        "多 Agent：圆桌探讨收场（form=roundtable）观点光谱英雄区 + 叙事后简报小结双产物",
        _multi_agent_roundtable_settled,
    ),
    "multi_agent_revision": ("多 Agent：定向唤回续写（revision 合成节点）", _multi_agent_revision),
    "multi_agent_plan_revised": (
        "多 Agent：自主再绑定「计划已调整」轻痕迹（plan_revised 折 bind/steer 到节点 revised）",
        _multi_agent_plan_revised,
    ),
    "multi_agent_multi_batch": (
        "多 Agent：同回合两批 delegate（合并 + 累计进度）",
        _multi_agent_multi_batch,
    ),
    "multi_agent_escalation": (
        "多 Agent：worker 升级实时可见（run_escalation 折到节点 escalations，非阻塞）",
        _multi_agent_escalation,
    ),
    "multi_agent_blocking_escalate": (
        "多 Agent：阻塞式求决策 答复路径（escalation_required→pending→resolved，回合不 paused）",
        _multi_agent_blocking_escalate,
    ),
    "multi_agent_blocking_escalate_timeout": (
        "多 Agent：阻塞式求决策 超时降级（escalation_resolved status=timeout，按假设续跑）",
        _multi_agent_blocking_escalate_timeout,
    ),
    "multi_agent_blocking_escalate_pending": (
        "多 Agent：阻塞式求决策 进行中（escalation_required 后挂起，回合仍 running、非 paused）",
        _multi_agent_blocking_escalate_pending,
    ),
    "multi_agent_blocking_escalate_multi": (
        "多 Agent：阻塞式求决策 同一 worker 串行多次升级（多升级 escalations[]，逐条结算）",
        _multi_agent_blocking_escalate_multi,
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
