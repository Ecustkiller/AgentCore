"""Delegate tool schema and constants.

Schema layer (工具面瘦身): short trigger + key param cues only. Routing judgment
lives in the CEO core; advanced HOW lives in ``consult_skill(team_orchestration_advanced)``.
"""

from __future__ import annotations

from agentcore.runtime.runs.constants import MAX_DELEGATION_TASKS
from agentcore.runtime.runs.playbooks import PLAYBOOKS, available_playbooks

# Shared task-level deliverable shape (delegate tasks + replan binds/add).
# Descriptions stay terse — full HOW is in team_orchestration_advanced.
TASK_DELIVERABLE_SCHEMA: dict[str, object] = {
    "type": "object",
    "description": (
        "可选交付物规格：name / form(prose|files) / required_sections / must_contain / "
        "篇幅 / output_format / requires_files / artifacts / strict。"
        "细节见 consult_skill(team_orchestration_advanced)。"
    ),
    "properties": {
        "name": {
            "type": "string",
            "description": "期望产出形态 / 要点。",
        },
        "form": {
            "type": "string",
            "enum": ["prose", "files"],
            "description": "prose=给用户看（正文）；files=给用户用（须落盘）。省略=worker 自判。",
        },
        "required_sections": {
            "type": "array",
            "items": {"type": "string"},
            "description": "验收：须覆盖的少数 Markdown 小标题（非完整骨架）。勿与 json 混用。",
        },
        "must_contain": {
            "type": "array",
            "items": {"type": "string"},
            "description": "验收：须出现的关键词（字面）。",
        },
        "min_length": {
            "type": "integer",
            "description": "最少字数。",
        },
        "max_length": {
            "type": "integer",
            "description": "最多字数。",
        },
        "output_format": {
            "type": "string",
            "enum": ["text", "json"],
            "description": "text 或 json；与 artifacts 同用时验文件可解析。勿与 required_sections 混用。",
        },
        "requires_files": {
            "type": "boolean",
            "description": "须 file_write 落盘。form=files / artifacts 已隐含时不必再设。",
        },
        "artifacts": {
            "type": "array",
            "items": {"type": "string"},
            "description": "声明式交付路径（相对工作区，可含通配）。",
        },
        "strict": {
            "type": "boolean",
            "description": "返工后仍不达标：true=硬退；false=软接受（默认）。",
        },
    },
}

# Tool-doc layer: terse trigger + pointer. Mechanics / routing HOW → skill + CEO core.
DELEGATE_DESCRIPTION = (
    "把任务拆给临时团队执行，产出回到你的循环（非终结）。"
    "实质任务默认组队；闲聊 / 单点事实 / 追问自己答。"
    f"tasks 数组（role+task 必填，单次≤{MAX_DELEGATION_TASKS}）；"
    "无依赖多节点=并行，depends_on=DAG。"
    "deliverable.form：产出给用户【看】→prose；给用户【用】→files。"
    "≥2 worker 根侧默认协调（立即返回、可同回合再调追加同一张图）；"
    "单 worker / finalize / 嵌套 lead / coordinate=false / 把关闸开则阻塞。"
    "进阶档位与形状词汇见 consult_skill(team_orchestration_advanced)。"
)

DELEGATE_PARAMETERS = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "description": (
                f"子任务列表（内联角色）。单次≤{MAX_DELEGATION_TASKS}；"
                "超出可同回合再调 delegate 追加或拆 DAG。"
            ),
            "items": {
                "type": "object",
                "properties": {
                    "role": {
                        "type": "string",
                        "description": "角色名，如『研究员』『前端工程师』。",
                    },
                    "task": {
                        "type": "string",
                        "description": (
                            "子任务（自包含：目标·约束·验收·分工）。worker 看不到完整历史；"
                            "勿把风险预判 / 专业知识代查写进 task（用 seed_notes heads_up）。"
                        ),
                    },
                    "objective": {
                        "type": "string",
                        "description": "可选：职责/目标，写入该 worker 系统提示。",
                    },
                    "tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选：允许的工具名。",
                    },
                    "retrieval_budget": {
                        "type": "integer",
                        "minimum": 0,
                        "description": (
                            "可选：本任务 web_search+read_url 合计次数上限（缓存命中不计）。"
                            "省略则按拓扑结构化默认：无上游=调研波额度；"
                            "有上游且 form=prose=0 且不装配检索工具；其余下游=小额。"
                            "显式声明恒优先。用尽后基于台账交付并标注缺口；"
                            "续派用 continue_from_run_id 并提额。"
                        ),
                    },
                    "model_preference": {
                        "type": "string",
                        "enum": ["fast", "strong"],
                        "description": "可选：模型档位，默认 strong。",
                    },
                    "reasoning_effort": {
                        "type": "string",
                        "enum": ["high", "max"],
                        "description": "可选（MVP 未下发）：仅解析存储。",
                    },
                    "deliverable": TASK_DELIVERABLE_SCHEMA,
                    "stance": {
                        "type": "string",
                        "enum": ["pro", "con"],
                        "description": "可选：对立任务立场（纯呈现）。",
                    },
                    "group": {
                        "type": "string",
                        "description": "可选：与 stance 配对的组标识。",
                    },
                    "round": {
                        "type": "integer",
                        "description": "可选：真·多轮辩论的轮次（纯呈现）。",
                    },
                    "id": {
                        "type": "string",
                        "description": "可选：供 depends_on 引用的本任务 id。",
                    },
                    "depends_on": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选：依赖的其它任务 id（出现即 DAG）。",
                    },
                    "result_handling": {
                        "type": "string",
                        "enum": ["pass_through", "summarize"],
                        "description": "可选：注入下游时原样或摘要，默认原样。",
                    },
                    "can_delegate": {
                        "type": "boolean",
                        "description": "可选：是否再向下委派（默认 true；depth 上限自动禁）。",
                    },
                    "replaces_run_id": {
                        "type": "string",
                        "description": (
                            "可选：接手/补派标记——被替换的失败（或取消）worker 的 "
                            "run_id。协调态补派失败节点时必填；引擎会把下游 "
                            "depends_on 中的旧 id 改写为本次新 run。"
                        ),
                    },
                    "continue_from_run_id": {
                        "type": "string",
                        "description": "可选：带现场续派（可唤回的 worker run_id）。",
                    },
                    "checkpoint_after": {
                        "type": "boolean",
                        "description": "可选：多步 DAG 波间请用户把关（默认 false）。",
                    },
                    "bind_after_deps": {
                        "type": "boolean",
                        "description": (
                            "可选：上游跑完后让出，用 replan 定稿本步（默认 false）。"
                        ),
                    },
                },
                "required": ["role", "task"],
            },
        },
        "finalize": {
            "type": "boolean",
            "description": "可选：单 worker 最终交付时直出（默认 false）。",
        },
        "coordinate": {
            "type": "boolean",
            "default": True,
            "description": (
                "可选，默认 true。≥2 worker 根侧非 finalize 时协调；false=阻塞等待。"
            ),
        },
        "playbook": {
            "type": "string",
            "enum": sorted(PLAYBOOKS),
            "description": (
                "可选：教学示例形状（与 tasks 二选一）。可用："
                + available_playbooks()
                + "。"
            ),
        },
        "playbook_args": {
            "type": "object",
            "description": (
                "可选：playbook 槽位。"
                + "；".join(f"{p.name}：{p.slots}" for p in PLAYBOOKS.values())
            ),
        },
        "coordination": {
            "type": "string",
            "enum": ["wall", "none"],
            "default": "none",
            "description": (
                "可选，默认 none。wall=便签墙；none=正交扇出。"
                "非空 seed_notes/team_brief 隐含 wall；light 隐含 none。"
            ),
        },
        "seed_notes": {
            "type": "array",
            "description": "可选：开跑前预贴便签（最多 8；隐含 wall）。",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["decision", "heads_up", "claim"],
                        "description": "便签类型，默认 heads_up。",
                    },
                    "text": {
                        "type": "string",
                        "description": "一行共识（≤200 字）。",
                    },
                },
                "required": ["text"],
            },
        },
        "team_brief": {
            "type": "string",
            "description": "可选：团队级共识长文（≤1500；隐含 wall）。",
        },
        "complexity_hint": {
            "type": "string",
            "enum": ["light", "standard"],
            "description": "可选：light=轻量（跳过墙等）；与 DAG 把关并存时忽略 light。",
        },
        "completion_criteria": {
            "description": (
                "可选完工验收：files_written / code_verified；"
                "custom 不被引擎验证。细节见 team_orchestration_advanced。"
            ),
            "oneOf": [
                {
                    "type": "string",
                    "enum": ["files_written", "code_verified"],
                },
                {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["custom"]},
                        "description": {
                            "type": "string",
                            "description": "自定义文字（引擎不校验）。",
                        },
                    },
                    "required": ["type"],
                },
            ],
        },
    },
}
