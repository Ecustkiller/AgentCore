"""Conformance vector builders — single-agent chat scenarios.

See ``vectors/__init__.py`` for the aggregated ``VECTORS`` registry.
"""

from __future__ import annotations

from agentcore.runtime.events import (
    FinishReason,
    citations_event,
    content_delta,
    content_reset,
    error_event,
    message_end,
    message_start,
    reasoning_delta,
    run_completed,
    run_context,
    run_plan,
    run_started,
    tool_use_end,
    tool_use_start,
)

from ._common import _CONV, _COST, _USAGE, _ctx_block

from collections.abc import Callable

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


VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "single_agent_text": ("单聊：思考+正文+总账，end_turn 完成", _single_agent_text),
    "single_agent_tool": ("单聊：思考→工具→正文（process 时间线）", _single_agent_tool),
    "single_agent_consult_memory": ("单聊：CEO 翻开记忆主题笔记（consult_memory → 查阅记忆卡片 + 全文）", _single_agent_consult_memory),
    "single_agent_error": ("单聊：正文中途 error 事件 → failed", _single_agent_error),
    "single_agent_citations": ("单聊：思考→工具→正文 + citations 来源卡", _single_agent_citations),
    "single_agent_content_reset": ("单聊：交付前核验回炉 (finish_guard) content_reset 丢弃违规版正文、重写修正版", _single_agent_content_reset),
    "single_agent_captain_context": ("单聊：CEO 收到的上下文（run_context kind=captain → 回合级 captainContext，system/history/request）", _single_agent_captain_context),
}
