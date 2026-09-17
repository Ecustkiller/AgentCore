"""Delegate tool schema and constants.

Schema layer (工具面瘦身): 信息判据四问 + 拆任务合同 + playbook/tasks 互斥.
何时用写在本 description（根 / 嵌套共用 ``DELEGATE_WHEN``，窗绑定分叉）；
编制 HOW 写在本按钮（根 / 嵌套共用填参与一块验收；嵌套另加拆层）。
不进常驻核、不另开按需 skill。
"""

from __future__ import annotations

from agentcore.runtime.delegate.playbook_declaration import HANDWRITTEN_TASKS_SKELETON
from agentcore.runtime.delegate.task_models import TASK_MODEL_SCHEMA_PROPS
from agentcore.runtime.runs.constants import MAX_DELEGATION_TASKS, MAX_GAP_FILL_ADDS
from agentcore.runtime.runs.playbooks import PLAYBOOKS, playbook_args_schema_description

# Shared task-level deliverable shape (delegate tasks + replan add).
# CEO / replan fill-in: optional artifact paths only. Write-vs-chat is task
# acceptance + the model; the engine only recognizes pinned paths.
# Playbook-internal knobs still parse in builder; they are not on this schema.
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
    "收益只认墙钟和注意力，人数不是理由。"
    "过程进你这扇窗之后每轮都还在 ≠ 这一回合装得下。"
    "有写权 ≠ 自己做完。不知读哪 ≠ 自己连搜。"
)

# 写 tasks 时必见。原 consult(staffing)/lead_subteam 上收进本按钮。
DELEGATE_STAFF_HOW = (
    "1 人只在活本身是一块："
    "同一份成稿的查证与起草是一块；点名了多份来源仍是 1 人取证。"
    "审查者 ≠ 作者。"
    "交了队长 ≠ 再平铺同名角色。"
    "收口后再动同一支团队：只写还要干的人并点名上一批 run_id ≠ 把上一批整表再交一遍。"
    "只报告的活默认 1 人、不催写盘。"
)
# 开局会注入用户原话 / 前置结果 / 并行队友任务；task 只写这一人的增量。
TASK_WINDOW_HOW = (
    "这一人的目标+边界+验收。"
    "用户原话、前置结果、并行队友任务由引擎注入 ≠ 再抄进 task。"
    "≠逐步改法、章节骨架。"
)
TASK_FILL_HOW = (
    "已拍板约束同一行「已确认约束：…」，没有则「（无）」；"
    "未拍板的标假设，改法与现状不进该行。"
    "未装配能力 ≠ 写入。"
    "点名入口或成品路径用工作区相对路径（正斜杠）。"
    "验收写清了解到什么算够：能拿去接着聊或接着做即可 ≠ 把范围内每处都查一遍。"
    "公开渠道没有：确认没有，用已有材料估计并标明不确定 = 完成。"
)
NESTED_STAFF_HOW = (
    "整段里程碑、空仓库多模块仍应拆 ≠ 凡大活必嵌套 ≠ 为了编排而编排。"
    "收工后由你整合交差。"
)

DELEGATE_DESCRIPTION = (
    f"拆任务给临时团队（默认手写顶层 tasks：role+task，≤{MAX_DELEGATION_TASKS}；非终结）。"
    f"默认用本工具：{DELEGATE_WHEN}"
    "你的窗跟会话走。"
    f"{DELEGATE_STAFF_HOW}"
)

# Nested captain: blocking wait, not coordination. Same fill contract; extra 拆层.
NESTED_DELEGATE_DESCRIPTION = (
    f"把当前任务拆给由你指挥的子团队（手写 tasks：role+task，≤{MAX_DELEGATION_TASKS}；"
    "调用后等到子队收工）。"
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
                            "生产者→消费者：空=同波并行。"
                            "排队只认本字段（本批 id / 角色名）≠ task 里写先后。"
                            "跨回合是新开一队。"
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
        "playbook": {
            "type": "string",
            "enum": sorted(PLAYBOOKS),
            "description": "固化流水线名（非默认快捷进阶）；与 tasks 二选一。",
        },
        "playbook_args": {
            "type": "object",
            "description": playbook_args_schema_description(),
        },
        "team_brief": {
            "type": "string",
            "description": (
                "有共享口径才写（一行一条）；各 worker 开局可见。省略即可。"
            ),
        },
    },
}
