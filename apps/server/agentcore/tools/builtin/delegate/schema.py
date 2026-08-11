"""Delegate tool schema and constants.

Schema layer (工具面瘦身): short trigger + key param cues only. Routing judgment
lives in the CEO core; advanced HOW lives in ``consult_skill(team_orchestration_advanced)``.
"""

from __future__ import annotations

from agentcore.runtime.delegate.playbook_declaration import HANDWRITTEN_TASKS_SKELETON
from agentcore.runtime.delegate.task_models import TASK_MODEL_SCHEMA_PROPS
from agentcore.runtime.runs.constants import MAX_DELEGATION_TASKS
from agentcore.runtime.runs.playbooks import PLAYBOOKS, playbook_args_schema_description

# Shared task-level deliverable shape (delegate tasks + replan binds/add).
TASK_DELIVERABLE_SCHEMA: dict[str, object] = {
    "type": "object",
    "description": (
        "可选交付物（form 等）。用户已拍板验收口径写入「已确认约束」；"
        "细节→team_orchestration_advanced。"
    ),
    "properties": {
        "form": {
            "type": "string",
            "enum": ["prose", "files"],
            "description": "prose=看；files=用（须落盘）。",
        },
        "required_sections": {"type": "array", "items": {"type": "string"}},
        "output_format": {"type": "string", "enum": ["text", "json"]},
        "artifacts": {"type": "array", "items": {"type": "string"}},
        "artifact_dir": {
            "type": "string",
            "description": "约定落盘目录（可选；可共享；省略走 stage_dirs 默认）。",
        },
        "strict": {
            "type": "boolean",
            "description": "不达标：true=硬退；false=软接受。",
        },
    },
}

# Trigger + short cues. Long HOW → CEO core / team_orchestration_advanced.
DELEGATE_DESCRIPTION = (
    f"拆任务给临时团队（默认手写顶层 tasks：role+task，≤{MAX_DELEGATION_TASKS}；非终结）。"
    f"默认可抄：{HANDWRITTEN_TASKS_SKELETON}（deliverable 可选）。"
    "具名 playbook 仅当走固化流水线时用（快捷进阶），且勿同时传 tasks。"
    "【看】→deliverable.form=prose；【用】→files。"
    "多任务先判生产者→消费者；互不依赖才平铺并行。"
    "≥1 worker 默认协调（立即返回、可同回合追加同一张图；含单 worker）。"
    "playbook 与 tasks 二选一：禁止二者同时有内容（反例：既填 code_audit 又传 tasks）。"
    "建站快捷套餐必填 playbook_args.topic；绿场必填 app。"
    "勿再填已删的 completion_criteria / requires_files / name / must_contain / min_length / objective / playbook_none_reason。"
    "HOW→consult_skill(team_orchestration_advanced)。"
)

DELEGATE_PARAMETERS = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "description": (
                f"默认主路（≤{MAX_DELEGATION_TASKS}）。"
                f"顶层非空数组可抄：{HANDWRITTEN_TASKS_SKELETON}（deliverable 可选）。"
                "手写此数组时勿填 playbook/playbook_id（或 playbook_id=\"none\"）；"
                "与具名 playbook 互斥。"
            ),
            "items": {
                "type": "object",
                "properties": {
                    "role": {"type": "string"},
                    "task": {
                        "type": "string",
                        "description": (
                            "自包含=目标+边界+验收（宜短；worker 看不到完整历史）。"
                            "已拍板项写入「已确认约束：…」块；"
                            "细则进任务范围/required_sections/artifacts；"
                            "全队共识进 team_brief。"
                        ),
                    },
                    "deliverable": TASK_DELIVERABLE_SCHEMA,
                    "id": {
                        "type": "string",
                        "description": (
                            "节点 id（可选）。铸 run_id={prefix}_{id}；"
                            "depends_on 可引用此字面值。"
                        ),
                    },
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "依赖 id（DAG）：本批 id / 同回合节点 id 或角色名；"
                            "勿手抄 del_*。跨回合须 append_to_execution_id。"
                            "何时填（生产者→消费者）见系统提示。"
                        ),
                    },
                    "result_handling": {
                        "type": "string",
                        "enum": ["pass_through", "summarize"],
                    },
                    "replaces_run_id": {"type": "string"},
                    "continue_from_run_id": {
                        "type": "string",
                        "description": "同人续派（调查后确认修 / 改稿）；填已完成 run_id。",
                    },
                    "checkpoint_after": {"type": "boolean"},
                    "bind_after_deps": {"type": "boolean"},
                    "require_upstream": {
                        "type": "boolean",
                        "description": "false=≥1 上游成功即跑；true=须全量。",
                    },
                    "force_continue": {"type": "boolean"},
                    "target_folder_id": {
                        "type": "string",
                        "description": (
                            "已解析项目 folder id。指定该队员坐哪张桌（换桌+记忆跟桌；"
                            "不改本会话 folder_id）。跨已登记项目（只读摸底与写盘通吃）须点名；"
                            "写不写盘由 write_scope/grant 正交（默认 none）；"
                            "裸聊写盘缺桌由运行时自动建云桌，勿为过闸 create_project；"
                            "有出生省略=默认桌；子派默认继承。"
                        ),
                    },
                    **TASK_MODEL_SCHEMA_PROPS,
                },
                "required": ["role", "task"],
            },
        },
        "finalize": {"type": "boolean"},
        "append_to_execution_id": {
            "type": "string",
            "description": (
                '跨回合追加："latest" 或 execution_id；'
                "同回合再调一般不必传。"
            ),
        },
        "coordinate": {
            "type": "boolean",
            "default": True,
            "description": "协调（默认 true）；false=阻塞。",
        },
        "force": {"type": "boolean", "default": False},
        "playbook": {
            "type": "string",
            "enum": sorted(PLAYBOOKS),
            "description": (
                "进阶/快捷（非默认）：固化流水线形状名；填了就不要传 tasks；槽位进 playbook_args。"
                "建站快捷→build_website；绿场→build_app；亦可用 playbook_id。"
            ),
        },
        "playbook_id": {
            "type": "string",
            "description": (
                '进阶/快捷（非默认）：playbook 名，或 "none"（手写 tasks 时用 none/省略，勿再带具名）；'
                "与 playbook 同义优先。"
            ),
        },
        "playbook_args": {
            "type": "object",
            "description": playbook_args_schema_description(),
        },
        "coordination": {
            "type": "string",
            "enum": ["wall", "none"],
            "default": "none",
        },
        "seed_notes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["decision", "heads_up", "claim"],
                    },
                    "text": {"type": "string"},
                },
                "required": ["text"],
            },
        },
        "team_brief": {
            "type": "string",
            "description": (
                "全队共识（含「已确认约束」）；各 worker 开局可见；"
                "约束块优先于附件旧角色表。"
            ),
        },
        "complexity_hint": {
            "type": "string",
            "enum": ["light", "standard"],
        },
        "parallelism": {
            "type": "string",
            "enum": ["conservative", "balanced", "aggressive"],
        },
    },
}
