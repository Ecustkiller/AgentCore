"""replan: the CEO's 波边界续跑 primitive — finalise / re-steer and resume the SAME
delegate plan (受监督的波循环).

The third orchestration primitive after ``delegate`` / ``revise``. The ``WaveScheduler``
YIELDs control back to the CEO at a *decision boundary* (instead of running an under- or
mis-specified tail) for two reasons, both surfaced as a non-terminal「计划已让出」brief:

- ``BIND`` (晚绑定, the CEO's *proactive* arm): a plan declared ``bind_after_deps``
  node(s) — steps whose spec is a placeholder until their upstream lands. The CEO reads
  the upstream products and finalises them (``binds``).
- ``SCOPE`` (偏离信号, the *reactive* arm / 自底向上): a finished worker flagged a 职责/范围
  deviation (``escalate kind=scope``) — what truly needs doing diverges from the initial
  plan. The CEO reads the deviation + output and re-steers the not-yet-run tail
  (``steers``).

Either way the CEO calls THIS tool — ``binds`` and/or ``steers`` (a SCOPE boundary may
also resume as-is when no change is needed), then resume the same DAG — or wrap up
(``stop``). Non-terminal, exactly like ``delegate``: the result returns to the CEO loop
(a further boundary brief, or the terminal team result).

A thin wrapper: it holds the turn's :class:`~agentcore.tools.builtin.delegate.DelegateTool`
and forwards to :meth:`DelegateTool.replan`, which owns the paused state (``_supervised``),
the validation, the in-place re-bind, and the resume drive. Worker usage / ledger /
citations therefore accumulate on the SAME DelegateTool instance the pipeline already
folds into the turn totals — this tool adds no accumulator of its own.

P3 范围：binds（定稿晚绑定节点）+ steers（操舵未跑节点）+ stop（收口）。``add``（追加新
节点，见设计 §7.1）推迟到后续阶段——它要管 id 生成与依赖接线，复杂度独立，先不并入。

→ 见设计: docs/07-规划/职责晚绑定与动态再编排设计.md §7.1（续跑入口=专用 replan 工具）
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema

if TYPE_CHECKING:
    from agentcore.tools.builtin.delegate import DelegateTool

logger = get_logger(__name__)

_REPLAN_DESCRIPTION = (
    "在 delegate 让出的波边界续跑同一计划。两种让出都会把控制权交回你（delegate 输出"
    "『计划已让出』）：①某步声明「依赖完成后再定稿」(bind_after_deps)、其上游跑完后交回你"
    "定稿——用 binds 据上游产出补全该步的职责 / 任务；②队员报告「职责偏离」(escalate "
    "kind=scope)、发现真正要做的与初始计划不符、交回你校准——用 steers 操舵【尚未运行】的"
    "下游步骤。两种都可同时用 binds + steers；定稿 / 校准后续跑同一张 DAG，确认无需改动可"
    "直接续跑，确无需继续则 stop=true 收口。本工具非终结：续跑结果（下一个边界简报或最终团"
    "队结果）回到你的循环，由你照常收尾。仅在收到『计划已让出』后可用；要发起新任务仍用 "
    "delegate。"
)

_REPLAN_PARAMETERS = {
    "type": "object",
    "properties": {
        "binds": {
            "type": "array",
            "description": (
                "把『待定稿』(bind_after_deps) 步骤定稿。每个元素 run_id 必填（取自『计划"
                "已让出』简报里每个待定稿步骤标注的 run_id），并据上游产出补全 role / task "
                "等——定稿后该步即可运行。"
            ),
            "items": {
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "要定稿的待定稿步骤 run_id（取自『计划已让出』简报）。",
                    },
                    "role": {
                        "type": "string",
                        "description": "定稿该步的角色名；省略则沿用占位角色。",
                    },
                    "task": {
                        "type": "string",
                        "description": (
                            "定稿该步的子任务（据上游产出写全、自包含）；省略则沿用占位任务。"
                        ),
                    },
                    "objective": {
                        "type": "string",
                        "description": "可选：该角色的职责 / 目标，用于设定其系统提示。",
                    },
                    "expected_output": {
                        "type": "string",
                        "description": "可选：期望产出的形态 / 要点。",
                    },
                    "model_preference": {
                        "type": "string",
                        "enum": ["fast", "strong"],
                        "description": "可选：模型档位，默认沿用占位值。",
                    },
                    "tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选：允许该步使用的工具名（取自可用工具）。",
                    },
                },
                "required": ["run_id"],
            },
        },
        "steers": {
            "type": "array",
            "description": (
                "可选：给其它【尚未运行】的步骤追加一条操舵说明（同 plan_review adjust 的机"
                "制——把指令注入该步，运行前生效）。已完成的步骤无法操舵。"
            ),
            "items": {
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "要操舵的未跑步骤 run_id。",
                    },
                    "note": {
                        "type": "string",
                        "description": "具体、可执行的操舵说明——改什么 / 怎么改。",
                    },
                },
                "required": ["run_id", "note"],
            },
        },
        "stop": {
            "type": "boolean",
            "description": (
                "可选，默认 false。确认无需继续跑剩余步骤时设 true：未跑步骤记为跳过，已完"
                "成产出交回你收尾。设 true 时 binds 可省略。"
            ),
        },
    },
    "required": [],
}


class ReplanTool:
    """CEO-agent tool that finalises late-bound nodes and resumes a paused delegate
    plan (non-terminal, like ``delegate``). Thin wrapper over
    :meth:`DelegateTool.replan` — it shares the DelegateTool's paused state and
    accumulator, so it carries no usage surface of its own."""

    def __init__(self, *, delegate: DelegateTool) -> None:
        # The turn's DelegateTool: owns ``_supervised`` (the paused plan), the
        # validation + in-place re-bind, the resume drive, and the shared
        # accumulator the pipeline folds. This tool just forwards the call.
        self._delegate = delegate

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="replan",
            description=_REPLAN_DESCRIPTION,
            parameters=_REPLAN_PARAMETERS,
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        return await self._delegate.replan(arguments)
