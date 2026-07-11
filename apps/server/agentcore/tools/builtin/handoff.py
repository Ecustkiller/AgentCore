"""handoff — a worker's structured 交接简报 + finish signal (完工交接简报单一源).

Worker-only, terminal. A delegated worker (leaf / debater / revision) ends its run by calling
``handoff`` ONCE, in the SAME turn as its finished deliverable, to submit a STRUCTURED brief
(给主管 / 下游队员看的交接): 结论 / 关键要点 / 关键假设 / 建议下一步.

Why a tool, not a「## 交接简报」markdown section (its former form): the brief is structured DATA
for READERS (下游依赖注入 / CEO 综述 / run-detail 卡), so it travels in a structured channel and is
read straight off the call's arguments
(:func:`~agentcore.runtime.runs.serialize.debrief_from_transcript`),
never parsed back out of prose. The deliverable stays the worker's streamed ``content``; this tool
carries ONLY the brief and signals the run is done — so the run-detail「输出」(the deliverable) and
「交接简报」(this brief) can never overlap the way a retained-in-prose section did.

Terminal by design (``ToolEffect.HANDOFF``): the worker writes its deliverable as content and calls
``handoff`` in the same round to finish. A terminal effect KEEPS that round's content (only prose
before a NON-terminal tool is rolled back as narration, Fork-B) — so ``content`` == the deliverable
and the brief rides the tool args. ``final_text`` is empty: the deliverable is already the streamed
content, so nothing is appended to it.

Optional for leaf workers (no downstream dependents): a worker may finish with a plain no-tool
answer (no ``handoff``) — then there is simply no debrief and the deliverable stands alone.
Nodes that feed downstream dependents **must** handoff (executor injects one correction shot;
still missing → engine synthesizes a degraded brief). Never pad a short leaf product with a
redundant restatement of itself.

Wired into the delegated worker toolset (``build_worker_registry``) and NOT into
``build_builtin_registry`` — so it never reaches the CEO's own toolset (``build_ceo_tool_registry``
derives the CEO subset from the builtins) or the read-only ``GET /tools`` capability catalog,
mirroring how ``escalate`` / ``post_note`` are wired in only where they belong.
"""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory, ToolEffect
from agentcore.runtime.runs.constants import HANDOFF_TOOL_NAME
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema

logger = get_logger(__name__)


class HandoffTool:
    """The worker's structured 交接简报 + finish primitive (terminal).

    Stateless: the call returns a terminal ``ToolResult`` that ends the run; the brief itself is
    read off THIS call's arguments by the executor's transcript harvest, so the tool owns only the
    done-signal + a short ack (the executor owns event shape / RunState, 引擎纯化)."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=HANDOFF_TOOL_NAME,
            description=(
                "完成本次任务后调用它【收尾并提交交接简报】——这是给主管 / 下游队员看的结构化交接，"
                "不是正文复述。用法：先把【交付正文】正常写出来（或用 file_write 落盘），然后在"
                "【同一轮】调用 handoff 收尾；调用它即代表你这次的活【已完成】，之后不再继续。\n"
                "简报只需几句、精炼具体：summary 一句话核心结论（必填）；key_points 下游 / 主管"
                "最该知道的 2-4 条（具体数字 / 文件路径 / 关键决定，别空泛）；assumptions 信息不足"
                "时你采用的关键假设（没有就省略）；next_steps 顺带给主管的后续建议（没有就省略——"
                "它与 escalate 不同：escalate 是『缺了它整件事会走偏、需现在有人拍板』，这里是"
                "『我已做完、提示个后续方向』）。\n"
                "别把简报重复写进交付正文，也不要在还没产出交付时就调用它。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "结论：一句话说清你这次做出了什么 / 核心结论。",
                    },
                    "key_points": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "关键要点：下游或主管最该知道的 2-4 条（具体数字 / 文件路径 / "
                            "关键决定，别空泛）。"
                        ),
                    },
                    "assumptions": {
                        "type": "string",
                        "description": "关键假设：信息不足时你采用的关键假设（没有就省略此条）。",
                    },
                    "next_steps": {
                        "type": "string",
                        "description": (
                            "建议下一步：基于你这一环的发现，团队 / 用户接下来值得考虑做什么"
                            "（没有就省略此条）。"
                        ),
                    },
                },
                "required": ["summary"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        summary = str(arguments.get("summary") or "").strip()
        logger.info(
            "worker.handoff",
            run_id=context.run_id,
            has_summary=bool(summary),
            chars=len(summary),
        )
        # Terminal (HANDOFF): the deliverable is already the run's streamed content, so this
        # carries NO final_text (nothing to append). The structured brief is read off THIS call's
        # arguments by serialize.debrief_from_transcript — the tool only signals「done + brief
        # submitted」. Its output is never fed back to the model (the loop ends here); it lands in
        # the transcript as a plain tool result for a later 续写 replay.
        return ToolResult(
            tool_call_id="",
            success=True,
            output="已收尾并提交交接简报。",
            effect=ToolEffect.HANDOFF,
            final_text="",
        )
