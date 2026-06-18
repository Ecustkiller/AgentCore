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
    error_event,
    message_end,
    message_start,
    plan_review_required,
    plan_review_resolved,
    reasoning_delta,
    run_completed,
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
    """多 Agent：辩论。runs 携带 ``stance``(pro/con) / ``group`` / ``round`` 显示标记——
    形状是数据不是模式，三端都从 plan 透传。"""
    agents = [
        {"id": "w1", "role": "正方", "model_preference": "strong", "thinking": True, "reasoning_effort": "high"},
        {"id": "w2", "role": "反方", "model_preference": "strong", "thinking": True, "reasoning_effort": "high"},
    ]
    plan_runs = [
        {"id": "r1", "agent_id": "w1", "task": "论证支持", "depends_on": [], "stance": "pro", "group": "g1", "round": 1},
        {"id": "r2", "agent_id": "w2", "task": "论证反对", "depends_on": [], "stance": "con", "group": "g1", "round": 1},
    ]
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("发起辩论。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="是否采用方案 A",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        run_output_delta("r1", "w1", "支持理由"),
        run_completed(
            "r1",
            "w1",
            output_summary="正方完成",
            duration_ms=800,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started("r2", "w2"),
        run_output_delta("r2", "w2", "反对理由"),
        run_completed(
            "r2",
            "w2",
            output_summary="反方完成",
            duration_ms=850,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        content_delta(" 双方已陈述。"),
        message_end(FinishReason.END_TURN, input_tokens=3000, output_tokens=500, cost=_COST),
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
    "multi_agent_worker_tool": ("多 Agent：worker 工具调用 + run_tool_progress 实时态", _multi_agent_worker_tool),
    "multi_agent_debate": ("多 Agent：辩论 stance/group/round 显示标记", _multi_agent_debate),
    "multi_agent_revision": ("多 Agent：定向唤回续写（revision 合成节点）", _multi_agent_revision),
    "multi_agent_multi_batch": ("多 Agent：同回合两批 delegate（合并 + 累计进度）", _multi_agent_multi_batch),
}
