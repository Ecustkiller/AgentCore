"""replan: the CEO's 波边界续跑 primitive — re-steer / append and resume the SAME
delegate plan (受监督的波循环).

The companion to ``delegate``. The ``WaveScheduler``
YIELDs control back to the CEO at a *decision boundary* (instead of running a
mis-specified tail) when a finished worker flagged a 职责/范围 deviation
(``escalate kind=scope``) or a 依赖缺口 (``escalate kind=dep``). The CEO reads the
signal + output and re-steers the not-yet-run tail (``steers``), appends a producer
(``add``), resumes as-is, or wraps up (``stop``).

Non-terminal, exactly like ``delegate``: the result returns to the CEO loop (a further
boundary brief, or the terminal team result).

A thin wrapper: it holds the turn's :class:`~agentcore.tools.builtin.delegate.DelegateTool`
and forwards to :meth:`DelegateTool.replan`, which owns the paused state (``_supervised``),
the validation, the in-place steer / append, and the resume drive. Worker usage / ledger /
citations therefore accumulate on the SAME DelegateTool instance the pipeline already
folds into the turn totals — this tool adds no accumulator of its own.

范围：steers（操舵未跑节点）+ add（追加新节点，id 生成 / 依赖接线
见 ``build_added_nodes``）+ stop（收口）。

→ 见设计: docs/03-AI核心/编排器与CEO主Agent.md §一 replan 原语（续跑入口=专用 replan 工具）
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolFace
from agentcore.runtime.delegate.task_models import TASK_MODEL_SCHEMA_PROPS
from agentcore.tools.builtin.delegate.schema import TASK_DELIVERABLE_SCHEMA
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_CEO_ONLY,
    CeoWire,
    ToolRegistration,
    ToolSurface,
)

if TYPE_CHECKING:
    from agentcore.tools.builtin.delegate import DelegateTool

logger = get_logger(__name__)

# Schema layer: short trigger. 字段 HOW 在让出简报与参数，不指空 consult。
_REPLAN_DESCRIPTION = (
    "在 delegate 让出『计划已让出』后续跑同一计划（非终结）。"
    "协调中加新角色用 delegate，勿等本工具。"
)

_REPLAN_PARAMETERS = {
    "type": "object",
    "properties": {
        "steers": {
            "type": "array",
            "description": "可选：给未跑步骤追加操舵说明。",
            "items": {
                "type": "object",
                "properties": {
                    "run_id": {
                        "type": "string",
                        "description": "未跑步骤 run_id。",
                    },
                    "note": {
                        "type": "string",
                        "description": "可执行的操舵说明。",
                    },
                },
                "required": ["run_id", "note"],
            },
        },
        "add": {
            "type": "array",
            "description": (
                "可选：追加全新步骤（role+task 必填；可 depends_on 现有 run_id 或本批 id）。"
            ),
            "items": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "可选：本批临时 id，供其它新步 depends_on。",
                    },
                    "role": {
                        "type": "string",
                        "description": "角色名。",
                    },
                    "task": {
                        "type": "string",
                        "description": "子任务（自包含）。",
                    },
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选：上游 run_id 或本批 id。",
                    },
                    "deliverable": TASK_DELIVERABLE_SCHEMA,
                    **TASK_MODEL_SCHEMA_PROPS,
                },
                "required": ["role", "task"],
            },
        },
        "stop": {
            "type": "boolean",
            "description": "可选：true=跳过未跑步并收口。",
        },
    },
    "required": [],
}


class ReplanTool:
    """CEO-agent tool that re-steers / appends and resumes a paused delegate
    plan (non-terminal, like ``delegate``). Thin wrapper over
    :meth:`DelegateTool.replan` — it shares the DelegateTool's paused state and
    accumulator, so it carries no usage surface of its own.
    """

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_CEO_ONLY,
        ceo_wire=CeoWire.COORDINATION,
        catalog_summary="调整已派出的计划",
    )

    def __init__(self, *, delegate: DelegateTool) -> None:
        # The turn's DelegateTool: owns ``_supervised`` (the paused plan), the
        # validation + in-place steer / append, the resume drive, and the shared
        # accumulator the pipeline folds. This tool just forwards the call.
        self._delegate = delegate

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="replan",
            description=_REPLAN_DESCRIPTION,
            parameters=_REPLAN_PARAMETERS,
            face=ToolFace.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        return await self._delegate.replan(arguments)
