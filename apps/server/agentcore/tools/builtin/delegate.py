"""delegate: the CEO main-agent's single orchestration primitive (统一 Run 模型 阶段3).

Replaces ``assemble_team``'s「升级 → 外部 planner LLM」铰链 with **D1′**：the CEO
(the high-frequency chat agent) itself decides *when* and *at what granularity* to
delegate, by calling this tool with a ``tasks`` array of inline workers. The tool
builds a RunPlan from those tasks (single / parallel / DAG falls out of the
``depends_on`` edges), drives it through the one ``WaveScheduler`` + the host
AGENT executor, and returns every worker's product back to the CEO.

Crucially it is **non-terminal**（D3 / Option 1，已确认）：unlike the legacy handoff
tool, ``delegate`` does NOT stream a final answer — it hands the workers' results
back into the CEO's own ReAct loop, so the CEO writes a SHORT user-facing overview
in its own voice (决策①：每个 worker 的完整产出在前端单独展示，CEO 不复述全文) and
may delegate again, adaptively. Worker token usage is accumulated on the instance
(``self.usage``) so the pipeline can fold it into the turn totals — a non-terminal
tool's output is otherwise not metered by the loop.

已接入 ``pipeline`` 作为 CEO 的唯一编排原语，取代 ``assemble_team``。

→ 见设计: docs/03-AI核心/编排器与CEO主Agent.md §一（delegate 原语）
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory, new_id
from agentcore.llm.config import agent_profile, apply_overrides
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.runtime.events import EventSink, run_plan, run_progress
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry

if TYPE_CHECKING:
    from agentcore.runtime.costing import RunCost

logger = get_logger(__name__)

# The CEO's synthesis reads the aggregated worker products as this tool's output;
# raise the model-facing truncation budget well above the 4000 default so a
# multi-worker batch isn't clipped before the CEO can integrate it.
_DELEGATE_OUTPUT_LIMIT = 16000

_DELEGATE_DESCRIPTION = (
    "把当前任务拆给一支由你（主 Agent）指挥的临时团队执行，并把各成员的产出"
    "返回给你。你自行决定粒度：传入一个 tasks 数组，每个元素是一个内联角色"
    "（role + task 必填）。无依赖且仅 1 个任务=单兵；无依赖多个=并行；任一任务"
    "声明 depends_on（引用其它任务的 id）=按依赖图分波执行，上游产出会自动注入"
    "下游。\n"
    "适用：需要多视角并行调研/对比、多阶段流水线（设计→实现→测试）、需要交叉"
    "审阅的复杂任务。普通问答/闲聊/单点搜索等简单请求不要委派，直接自己回答。\n"
    "重要：本工具不会替你回复用户。团队产出会作为结果回到你这里；用户可在界面"
    "查看每个成员的完整产出，因此你只需用自己的声音写一段简短概览（综述关键结论、"
    "串起整体、指引用户去看细节），不要逐字复述全文；可在看到结果后再次调用本工具"
    "继续委派。"
)

_DELEGATE_PARAMETERS = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "description": "要委派的子任务列表（每个是一个内联角色 worker）。",
            "items": {
                "type": "object",
                "properties": {
                    "role": {
                        "type": "string",
                        "description": "worker 的角色名，如『研究员』『前端工程师』。",
                    },
                    "task": {
                        "type": "string",
                        "description": (
                            "交给该 worker 的子任务，须完整自包含"
                            "（worker 看不到完整对话，只收到这段）。"
                        ),
                    },
                    "objective": {
                        "type": "string",
                        "description": "可选：该角色的职责/目标，用于设定其系统提示。",
                    },
                    "tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选：允许该 worker 使用的工具名（取自可用工具）。",
                    },
                    "model_preference": {
                        "type": "string",
                        "enum": ["fast", "strong"],
                        "description": "可选：模型档位，默认 strong。",
                    },
                    "reasoning_effort": {
                        "type": "string",
                        "enum": ["high", "max"],
                        "description": "可选：极复杂子任务可设 max 解锁更深推理。",
                    },
                    "expected_output": {
                        "type": "string",
                        "description": "可选：期望产出的形态/要点。",
                    },
                    "id": {
                        "type": "string",
                        "description": "可选：DAG 模式下供 depends_on 引用的本任务标识。",
                    },
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选：依赖的其它任务 id（出现任一即进入 DAG 模式）。",
                    },
                    "result_handling": {
                        "type": "string",
                        "enum": ["pass_through", "summarize"],
                        "description": "可选：该产出注入下游时是原样还是摘要，默认原样。",
                    },
                    "contract": {
                        "type": "object",
                        "description": (
                            "可选：对该 worker 产出的质量要求（机械校验）。不达标会带着"
                            "具体差距自动返工一次；默认仅标记提醒，strict=true 则必须达标。"
                        ),
                        "properties": {
                            "required_sections": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "产出必须包含的小标题，如『结论』『风险』。",
                            },
                            "must_contain": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "产出必须出现的关键词/内容。",
                            },
                            "min_length": {
                                "type": "integer",
                                "description": "产出最少字数，低于则判未达标。",
                            },
                            "max_length": {
                                "type": "integer",
                                "description": "产出最多字数，超过则判未达标。",
                            },
                            "output_format": {
                                "type": "string",
                                "enum": ["text", "json"],
                                "description": "要求的产出格式；json 会校验能否解析。",
                            },
                            "strict": {
                                "type": "boolean",
                                "description": (
                                    "true=不达标必须返工（硬）；false=仅提醒（软，默认）。"
                                ),
                            },
                        },
                    },
                },
                "required": ["role", "task"],
            },
        },
    },
    "required": ["tasks"],
}


class DelegateTool:
    """CEO-agent tool that delegates sub-tasks to a Run plan and returns their
    products for the CEO to synthesize (non-terminal, Option 1)."""

    def __init__(
        self,
        *,
        llm: DeepSeekProvider,
        sink: EventSink,
        system_prompt: str,
        user_message: str,
        history: list[dict],
        tools: ToolRegistry,
        base_tool_context: ToolContext,
        max_parallel: int | None = None,
        captain_run_id: str | None = None,
    ) -> None:
        self._llm = llm
        self._sink = sink
        self._system_prompt = system_prompt
        self._user_message = user_message
        self._history = history
        self._tools = tools
        self._base_tool_context = base_tool_context
        self._max_parallel = max_parallel
        # The delegating CEO's synthetic root run id, so every member's ledger row
        # points its ``parent_run_id`` at the captain and the turn's run tree is
        # reconstructable. None when the tool runs standalone (e.g. tests).
        self._captain_run_id = captain_run_id
        # Run-id namespacing across multiple delegate calls in one turn, so an
        # adaptive captain's second batch never collides with the first.
        self._calls = 0
        # Worker token usage accumulated across every delegate call this turn; the
        # pipeline folds this into the turn totals after the CEO loop returns. The
        # cache_hit/cache_miss split rides along so the folded total stays
        # priceable (a cache hit is ~50× cheaper than a miss).
        self.usage: dict[str, int] = {
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache_hit": 0,
            "cache_miss": 0,
        }
        # Per-run cost ledger rows accumulated across every delegate call this
        # turn (决策②: one row per worker run). The pipeline reads this, appends
        # the captain root row, and hands the lot to the service for 落账.
        self.run_ledger: list[RunCost] = []

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="delegate",
            description=_DELEGATE_DESCRIPTION,
            parameters=_DELEGATE_PARAMETERS,
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        # Lazy import: keep the tools package free of an import-time dependency on
        # the runtime.runs package (which imports the engine, which imports this
        # registry) — avoids a circular import.
        from agentcore.runtime.runs import (
            DEFAULT_MAX_PARALLEL,
            RunPhase,
            WaveScheduler,
            build_agent_executor,
            build_run_plan,
        )

        tasks_raw = arguments.get("tasks")
        if not isinstance(tasks_raw, list) or not tasks_raw:
            msg = "'tasks' 必须是非空数组：每个元素至少包含 role 和 task。"
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg, terminal=False)

        valid_tools = {s.name for s in self._tools.list_all()}
        self._calls += 1
        prefix = f"del{self._calls}_{int(time.time() * 1000)}"
        plan, errors = build_run_plan(tasks_raw, valid_tools=valid_tools, id_prefix=prefix)
        if errors:
            msg = "委派任务无效：" + "；".join(errors)
            logger.info("delegate_rejected", errors=errors)
            return ToolResult(tool_call_id="", success=False, output=msg, error=msg, terminal=False)

        execution_id = self._base_tool_context.execution_id or new_id()
        self._sink.emit(self._plan_event(execution_id, plan))
        logger.info("delegate_started", nodes=len(plan.nodes), call=self._calls)

        executor = build_agent_executor(
            plan=plan,
            llm=self._llm,
            tools=self._tools,
            sink=self._sink,
            base_tool_context=self._base_tool_context,
            system_prompt=self._system_prompt,
            user_message=self._user_message,
            execution_id=execution_id,
        )

        total = len(plan.nodes)

        def _progress(completed) -> None:
            done = sum(1 for s in completed.values() if s.phase is RunPhase.COMPLETED)
            self._sink.emit(run_progress(done, total))

        results = await WaveScheduler(self._max_parallel or DEFAULT_MAX_PARALLEL).run(
            plan, executor, on_progress=_progress
        )

        call_usage = self._accumulate_usage(results)
        self._collect_ledger(plan, results)
        output = self._format_for_ceo(plan, results)
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            terminal=False,
            output_limit=_DELEGATE_OUTPUT_LIMIT,
            metadata={
                "input_tokens": call_usage["input"],
                "output_tokens": call_usage["output"],
                "reasoning_tokens": call_usage["reasoning"],
                "cache_hit_tokens": call_usage["cache_hit"],
                "cache_miss_tokens": call_usage["cache_miss"],
            },
        )

    def _accumulate_usage(self, results: dict) -> dict[str, int]:
        """Sum this call's worker token usage and fold it into the turn total."""
        call = {"input": 0, "output": 0, "reasoning": 0, "cache_hit": 0, "cache_miss": 0}
        for state in results.values():
            for key in call:
                call[key] += state.usage.get(key, 0)
        for key in call:
            self.usage[key] += call[key]
        return call

    def _collect_ledger(self, plan, results: dict) -> None:
        """Capture each worker run that metered LLM usage as a per-run cost row.

        Reads the cost the executor already priced onto each terminal RunState
        (no re-pricing) and parents the row to the captain. Runs that never hit
        the LLM (skipped, or failed before any call) carry no usage and are not
        billed.
        """
        from agentcore.runtime.costing import member_run_cost

        for node in plan.nodes:
            state = results.get(node.run_id)
            if state and state.usage:
                self.run_ledger.append(
                    member_run_cost(node, state, parent_run_id=self._captain_run_id)
                )

    def _format_for_ceo(self, plan, results: dict) -> str:
        """Render the workers' products as the CEO's overview input.

        The CEO reads the full per-worker products here so its overview is
        accurate, but is instructed to write only a SHORT synthesis (决策①) — the
        user reads each worker's full output in the UI, not in the CEO's reply.
        """
        lines = ["## 团队执行结果（据此写一段简短概览交给用户；完整详情用户自行查看）"]
        for node in plan.nodes:
            state = results.get(node.run_id)
            status = state.phase.value if state else "unknown"
            label = node.role or node.run_id
            if state and state.content:
                body = state.content
            elif state and state.error:
                body = f"（失败：{state.error}）"
            else:
                body = "（无输出）"
            if state and state.warnings:
                warns = "；".join(state.warnings)
                body += f"\n\n> 质检提醒（未完全达标，请判断是否需要返工）：{warns}"
            lines.append(f"\n### {label}（{status}）\n{body}")
        lines.append(
            "\n---\n以上为各 worker 的完整产出（用户可在界面逐个展开查看）。"
            "请用你自己的声音写一段【简短概览】：综述各成员的关键结论、串起整体、"
            "指引用户去看细节即可——不要逐字复述每个 worker 的全文，也不要罗列内部"
            "步骤或 Agent。如仍需补充工作，可再次调用 delegate。"
        )
        return "\n".join(lines)

    def _plan_event(self, execution_id: str, plan):
        """Pre-declare this delegate batch's roster + runs so the graph lights up."""
        roles = list(dict.fromkeys(n.role for n in plan.nodes if n.role))
        return run_plan(
            execution_id=execution_id,
            plan_type="multi_agent",
            task_summary=f"{len(plan.nodes)} 个 worker：{'、'.join(roles)}" if roles else "",
            agents=[self._card(n) for n in plan.nodes],
            runs=[
                {
                    "id": n.run_id,
                    "agent_id": n.agent_id,
                    "task": n.task,
                    "depends_on": n.depends_on,
                }
                for n in plan.nodes
            ],
        )

    def _card(self, node) -> dict[str, Any]:
        """Roster entry with the node's *effective* (post-clamp) thinking/effort."""
        profile = apply_overrides(
            agent_profile(node.model_preference),
            thinking=node.thinking,
            reasoning_effort=node.reasoning_effort,
        )
        return {
            "id": node.agent_id,
            "role": node.role,
            "model_preference": node.model_preference,
            "thinking": profile.thinking,
            "reasoning_effort": profile.reasoning_effort,
        }
