"""User workflows (账户级可保存团队拆法).

Definition validate/expand → direct-start delegate → topology lock.
Official playbook → definition copy (not registered into PLAYBOOKS).
抽槽参数化（``slot_extract`` / ``slots``：占位符 + 默认值 = 原轮原值）是复用它之前的按需
一步，走 ``POST /v1/workflows/{id}/suggest-slots``。

**所有权**：``definition``（nodes / edges / slots）归用户，客户端整份覆盖、服务端只校验不
重建（``definition``）；来源标记归服务端，落在 ``user_workflows.source`` 列上而不是画布里
（``source``）。历史 ``kind=turn`` 行仍认、仍可抽槽；新工作流从工具箱设计，对话不再固化。
"""

from agentcore.workflows.definition import (
    WorkflowDefinitionError,
    expand_workflow_to_tasks,
    tasks_to_workflow_definition,
    validate_workflow_definition,
)
from agentcore.workflows.slots import (
    resolve_slot_values,
    slots_from_definition,
)
from agentcore.workflows.source import (
    TURN_SOURCE_KIND,
    is_turn_sourced,
    normalize_source,
    turn_source,
)

__all__ = [
    "TURN_SOURCE_KIND",
    "WorkflowDefinitionError",
    "expand_workflow_to_tasks",
    "is_turn_sourced",
    "normalize_source",
    "resolve_slot_values",
    "slots_from_definition",
    "tasks_to_workflow_definition",
    "turn_source",
    "validate_workflow_definition",
]
