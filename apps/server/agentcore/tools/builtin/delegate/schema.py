"""Delegate tool schema and constants.

Schema layer (工具面瘦身): 信息判据四问 + 拆任务合同.
何时用写在本 description（根 / 嵌套共用 ``DELEGATE_WHEN``，窗绑定分叉）；
编制 HOW 写在本按钮（根 / 嵌套共用填参与一块验收；嵌套另加拆层）。
不进常驻核、不另开按需 skill。
"""

from __future__ import annotations

from agentcore.runtime.delegate import empty_tasks as _empty_tasks
from agentcore.runtime.delegate.task_models import TASK_MODEL_SCHEMA_PROPS
from agentcore.runtime.runs.constants import MAX_DELEGATION_TASKS, MAX_GAP_FILL_ADDS

EMPTY_DELEGATE_MSG = _empty_tasks.EMPTY_DELEGATE_MSG
HANDWRITTEN_TASKS_SKELETON = _empty_tasks.HANDWRITTEN_TASKS_SKELETON
is_empty_delegate_error = _empty_tasks.is_empty_delegate_error


# Shared task-level deliverable shape (delegate tasks + replan add).
# CEO / replan fill-in: optional artifact paths only. Write-vs-chat is task
# acceptance + the model; the engine only recognizes pinned paths.
TASK_DELIVERABLE_SCHEMA: dict[str, object] = {
    "type": "object",
    "description": "可选。用户点名或流水线写死才填 artifacts；省略=不催写盘。",
    "properties": {
        "artifacts": {
            "type": "array",
            "items": {"type": "string"},
            "description": "路径列表。",
        },
    },
}

# Shared when-to-use（根 / 嵌套同一条信息判据操作形；场面表不进按钮）。
# 窗绑定与机械尾巴分叉：根=会话窗+立刻返回；嵌套=这张任务卡+阻塞收工。
DELEGATE_WHEN = (
    "切出去判断还成立吗？否→自己做。"
    "切出去是换墙钟还是换注意力？都没有→自己做。"
    "写成目标·边界·验收再加编排和综述，还小于收益吗？否→自己做。"
    "过程进你这扇窗之后每轮都还在 ≠ 这一回合装得下。"
    "有写权 ≠ 自己做完。不知读哪 ≠ 自己连搜。"
)

# 写 tasks 时必见。原 consult(staffing)/lead_subteam 上收进本按钮。
# 一块的例子（成稿查证+起草 / 多来源取证）在编排器文档，不进按钮。
DELEGATE_STAFF_HOW = (
    "1 人只在活本身是一块。"
    "同一话题的切面 ≠ 按切面一人。"
    "点名对比 N 个对象 → 至少 N 人。"
)
# 开局会注入用户原话 / 前置结果 / 并行队友任务；task 只写这一人的增量。
# 骨架已写「目标+边界+验收」；不钉「已确认约束：」行格式（引擎不解析）。
TASK_WINDOW_HOW = (
    "用户原话、前置结果、并行队友任务由引擎注入 ≠ 再抄进 task。"
    "≠逐步改法、章节骨架。"
)
TASK_FILL_HOW = (
    "已拍板约束写进 task；没有写无；未拍板标假设 ≠ 改法/现状当约束。"
    "点名路径用工作区相对正斜杠。"
    "验收=了解到什么算够 ≠ 范围内每处都查；公开渠道没有=完成。"
)
NESTED_STAFF_HOW = "收工后由你整合交差。"

DELEGATE_DESCRIPTION = (
    "拆任务给临时团队（非终结）。"
    f"{DELEGATE_WHEN}"
    f"{DELEGATE_STAFF_HOW}"
)

# Nested captain: blocking wait, not coordination. Same fill contract; extra 拆层.
NESTED_DELEGATE_DESCRIPTION = (
    "把当前任务拆给由你指挥的子团队（调用后等到子队收工）。"
    f"{DELEGATE_WHEN}"
    "你的窗跟这张任务卡走，卡上已是一件则留下。"
    f"{DELEGATE_STAFF_HOW}"
    f"{NESTED_STAFF_HOW}"
)

DELEGATE_PARAMETERS = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "description": (
                f"默认主路（≤{MAX_DELEGATION_TASKS}）。"
                f"顶层非空数组可抄：{HANDWRITTEN_TASKS_SKELETON}（deliverable 可选）。"
            ),
            "items": {
                "type": "object",
                "properties": {
                    "role": {"type": "string"},
                    "task": {
                        "type": "string",
                        "description": TASK_WINDOW_HOW + TASK_FILL_HOW,
                    },
                    "deliverable": TASK_DELIVERABLE_SCHEMA,
                    "id": {
                        "type": "string",
                        "description": "可选节点 id。depends_on 可引用此字面值。",
                    },
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "空=同波并行。"
                            "只认本字段（本批 id / 角色名）≠ task 里写先后。"
                        ),
                    },
                    "replaces_run_id": {
                        "type": "string",
                        "description": (
                            "补缺口：接手某个失败/跳过的 run（填其 run_id）。"
                            f"单次≤{MAX_GAP_FILL_ADDS}。"
                        ),
                    },
                    "continue_from_run_id": {
                        "type": "string",
                        "description": (
                            "同人续派（调查后确认修 / 改稿 / 收口后接着干）；填已完成 run_id。"
                        ),
                    },
                    "target_folder_id": {
                        "type": "string",
                        "description": (
                            "已解析文件夹 id（该队员坐哪张桌）。"
                            "跨已登记文件夹（只读摸底与改盘通吃）须点名；"
                            "云端草稿 ≠ 读不到已有文件夹。接到工作区 / 挂载 ≠ 换桌。"
                        ),
                    },
                    **TASK_MODEL_SCHEMA_PROPS,
                },
                "required": ["role", "task"],
            },
        },
        "append_to_execution_id": {
            "type": "string",
            "description": (
                '跨回合接续上一张图：只填 "latest"（引擎解析）；'
                "同回合再调一般不必传。"
            ),
        },
        "team_brief": {
            "type": "string",
            "description": (
                "有共享口径才写（一行一条）；各 worker 开局可见。省略即可。"
            ),
        },
    },
}
