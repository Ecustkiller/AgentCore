"""Delegate tool schema and constants."""

from __future__ import annotations

from agentcore.runtime.runs.constants import MAX_DELEGATION_TASKS
from agentcore.runtime.runs.playbooks import PLAYBOOKS, available_playbooks

# The CEO's synthesis reads the aggregated worker products as this tool's output;
# raise the model-facing truncation budget well above the 4000 default so a
# multi-worker batch isn't clipped before the CEO can integrate it. ``format_for_ceo``
# now does the STRUCTURED bounding (per-product fidelity + a shared prose budget,
# CEO 综述输入瘦身) so the aggregate fits comfortably under this; the cap stays only as
# a last-resort net (the old behaviour: a blunt head-chop that dropped late workers).
DELEGATE_OUTPUT_LIMIT = 16000

# Shared task-level deliverable shape (delegate tasks + replan binds/add).
TASK_DELIVERABLE_SCHEMA: dict[str, object] = {
    "type": "object",
    "description": (
        "可选：该 worker 的交付物规格——描述性（name）与验收底线（required_sections / "
        "must_contain / 篇幅 / 格式 / requires_files / strict）合一。name 描述期望产出形态；"
        "其余字段声明产出必须满足的硬性兜底（非事前结构蓝图）。不达标会带着具体差距自动返工一次；"
        "返工后仍不达标时，默认仅附质检提醒（软），strict=true 则判该 worker 失败（硬退）。"
    ),
    "properties": {
        "name": {
            "type": "string",
            "description": "期望产出的形态 / 要点。",
        },
        "required_sections": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "验收底线：产出必须覆盖的少数关键部分（按小标题校验是否在场），"
                "如『结论』『风险』。用于兜底「别漏掉关键内容」，不是用来替专家"
                "规定完整章节骨架——交付物的结构由 worker 设计。"
            ),
        },
        "must_contain": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "验收底线：产出必须出现的关键词 / 内容（字面校验）；只兜关键点，"
                "不是用来规定结构。"
            ),
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
        "output_schema": {
            "type": "object",
            "description": "output_format=json 时可选的 JSON Schema。",
        },
        "requires_files": {
            "type": "boolean",
            "description": (
                "产出是落盘文件（可运行代码 / 网页 / 应用、脚本、配置、"
                "数据文件等用户要打开 / 运行 / 保存的东西）时设 true：未调用"
                " file_write 把产物写进工作区即判未达标、自动返工，杜绝把整份"
                "文件内容粘在回复正文、工作区却空着。纯文字交付（分析 / 说明 /"
                " 问答）不要设。"
            ),
        },
        "strict": {
            "type": "boolean",
            "description": (
                "决定返工后仍不达标时的处置（返工一次与本字段无关、"
                "总会先发生）：true=判该 worker 失败（硬退）；"
                "false=仍接受产出、仅附质检提醒（软，默认）。"
            ),
        },
    },
}

# Per-step product excerpt cap in a plan_review card (结构化挂起 2a): enough for the
# user to recognise what just finished without shipping the whole product over SSE.
PLAN_REVIEW_SUMMARY_CHARS = 280

# Tool-doc layer (提示词瘦身 §三去重)：only the delegate MECHANICS live here — what the
# tool does, how the tasks array maps to single/parallel/DAG, and that it is
# non-terminal. The routing JUDGMENT (何时委派 / 怎么扇出) is owned ONCE by the CEO core
# (prompt._CEO_CORE_HINT, always-on); the advanced knobs' HOW lives in the
# team_orchestration_advanced skill + each param's own description. This description
# therefore keeps only a TERSE one-line routing reminder + a pointer, instead of
# re-teaching the criterion the core already states every turn (was a ~2x duplication).
DELEGATE_DESCRIPTION = (
    "把当前任务拆给一支由你（主 Agent）指挥的临时团队执行，并把各队员的产出返回给你。"
    "本工具非终结：产出回到你的循环，你据此写一段简短概览（不逐字复述，用户可在界面看"
    "各成员全文），必要时再次调用继续委派。\n"
    "粒度由你定：传入一个 tasks 数组（每个元素一个内联角色，role + task 必填）。"
    f"单次最多 {MAX_DELEGATION_TASKS} 个节点，超出会被拒绝，请自行分批。\n"
    "无依赖且仅 1 个=单兵；无依赖多个=并行；任一任务声明 depends_on（引用其它任务的 id）"
    "=按依赖图分波执行，上游产出自动注入下游。\n"
    "若本次的活正好是几个高频形状之一（调研报告 / 接口＋页面＋测试 / 多选项对比），可改用 "
    "`playbook` 一键实例化整支团队、免手搓 tasks（与 tasks 二选一，槽位见 playbook / playbook_args 说明）。\n"
    "简单问答 / 闲聊 / 检索自己答；交付物（要产出或改动产物的活——写 / 改文件、删除 / 移动、"
    "运行代码，这些工具只 worker 持有）才用本工具，哪怕只派一个。其余进阶档位（finalize / "
    "can_delegate / deliverable / 模型档位 / 流水线等）见对应参数说明与 "
    "consult_skill(team_orchestration_advanced)。"
)

DELEGATE_PARAMETERS = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "description": (
                f"要委派的子任务列表（每个是一个内联角色 worker）。"
                f"单次最多 {MAX_DELEGATION_TASKS} 个节点，超出请分批。"
            ),
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
                            "交给该 worker 的子任务。worker 会另外收到「原始用户请求」，"
                            "但看不到完整对话历史、也看不到你的思考；因此这里要把完成该"
                            "任务所需、原始请求之外的上下文写全，做到自包含。"
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
                        "description": (
                            "可选（MVP 未下发）：解析并存储，当前不进 LLM 请求体；"
                            "high/max 暂不区分效果，保留供后续 per-provider 适配。"
                        ),
                    },
                    "deliverable": TASK_DELIVERABLE_SCHEMA,
                    "stance": {
                        "type": "string",
                        "enum": ["pro", "con"],
                        "description": (
                            "可选：仅用于【辩论 / 交叉审查】这类对立任务——标记该 worker 的"
                            "立场（pro=正方/支持，con=反方/反对）。纯前端呈现信号、执行不受"
                            "影响（仍是普通并行）；前端据此把正反产出并排对比、并把回合标记为"
                            "「辩论」。普通的并行分工不要设。"
                        ),
                    },
                    "group": {
                        "type": "string",
                        "description": (
                            "可选：与 stance 搭配，给同一组对立任务一个共同标识，把正/反"
                            "配对（一次可有多组对比 / 多维审查）。只有一组时可省略。"
                        ),
                    },
                    "round": {
                        "type": "integer",
                        "description": (
                            "可选：仅用于【真·多轮辩论】——标记该 task 属于第几轮（从 1 起）。"
                            "配合跨轮 depends_on（第 k 轮的一方依赖第 k-1 轮对方的产出）让"
                            "交锋逐轮推进。纯前端呈现信号、执行不受影响；前端据此按轮次分层"
                            "展示。单轮辩论 / 普通分工不要设。"
                        ),
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
                    "can_delegate": {
                        "type": "boolean",
                        "description": (
                            "可选：控制该 worker 是否能再向下委派子团队。true（默认）= 启动即获得 "
                            "delegate + replan（depth 达上限时自动禁用）；false = 显式禁止委派。"
                        ),
                    },
                    "replaces_run_id": {
                        "type": "string",
                        "description": (
                            "可选：回落换人标记。当 revise 未命中 / 超改次上限、改用本工具重派新人时，"
                            "填被接手的原 worker 的 run_id——前端在图上标「接手」角标与「接替」边；"
                            "执行不受影响。普通委派不要设。"
                        ),
                    },
                    "checkpoint_after": {
                        "type": "boolean",
                        "description": (
                            "可选，默认 false。仅用于【同一次 delegate 的多步 DAG】：给某个"
                            "高危 / 不可逆 / 范围可能跑偏的中间步骤设 true，则该步完成后、其"
                            "下游步骤运行前会自动暂停，请用户过目当前进展并决定「继续 / 停止」。"
                            "克制使用——只在确实值得让用户在继续前把关的节点设；单步委派或"
                            "末步设了也不会触发（其后无下游可把关，那种情况改用 ask_user）。"
                        ),
                    },
                    "bind_after_deps": {
                        "type": "boolean",
                        "description": (
                            "可选，默认 false。仅用于【同一次 delegate 的多步 DAG】里某个下游"
                            "步骤：当它该做什么必须看上游产出才能定（典型：先调研 A、再据 A 的"
                            "发现写 B，而 B 的具体职责取决于 A 查出什么），把该步设 true、其 "
                            "role / task 先写成占位即可；它的全部上游完成后、本步运行前，控制权"
                            "会交回你（delegate 输出『计划已让出』），你据上游产出用 replan 把它"
                            "定稿再续跑同一计划。克制使用——只在『此刻写死下游 spec 很可能跑偏』"
                            "时设；上游已定、下游 spec 现在就能写清的步骤不要设（徒增一次回合）。"
                        ),
                    },
                },
                "required": ["role", "task"],
            },
        },
        "finalize": {
            "type": "boolean",
            "description": (
                "可选，默认 false。仅当本次只派【一个】worker、且这次委派就是整件事的"
                "最终交付（如建一个文件、改一行、产出一段可独立阅读的内容）时设 true："
                "该 worker 成功后，其产出会直接作为你的最终答复呈现给用户，你不必再写"
                "概览。只要你可能在看到结果后还要继续委派 / 补充，或本次派了多个 worker，"
                "就不要设——默认会把结果交回你来收尾；worker 失败时也会自动回落到由你收尾。"
            ),
        },
        "coordinate": {
            "type": "boolean",
            "default": True,
            "description": (
                "可选，默认 true（省略即协调）。当本次派【≥2 个】worker 且为根 CEO、"
                "非 finalize 时：delegate 立即返回『团队已启动』，你进入协调模式，消费"
                "团队事件并用 update_synthesis / cancel_worker / resolve_escalation 边看边调；"
                "全部完成后做最终合成。传 false 显式退出到经典阻塞等待（等全队完成再返回）。"
                "单 worker、finalize、嵌套 lead 无论本参数如何都不进协调。"
            ),
        },
        "playbook": {
            "type": "string",
            "enum": sorted(PLAYBOOKS),
            "description": (
                "可选：用一个【固化形状】一键实例化整支团队，替代手搓 tasks（与 tasks 二选一）。"
                "设了 playbook 就把槽位放进 playbook_args、不要再传 tasks。可用：" + available_playbooks()
                + "。仅当你的活正好是这些高频形状之一时用；形态特殊就照常手写 tasks 数组。"
            ),
        },
        "playbook_args": {
            "type": "object",
            "description": (
                "可选：playbook 的槽位填充（与 playbook 搭配；不传 playbook 时忽略）。各 playbook 槽位——"
                + "；".join(f"{p.name}：{p.slots}" for p in PLAYBOOKS.values())
            ),
        },
        "seed_notes": {
            "type": "array",
            "description": (
                "可选：主 Agent 在团队开跑前预贴到便签墙的共识（一行一条，最多 8 条）。"
                "并行 worker 开局即能通过便签墙收到，减少在每个 task 里重复粘贴同一段背景。"
                "kind 同 post_note：decision=我定了 / heads_up=提个醒 / claim=我领了。"
            ),
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
                        "description": "一行具体共识（≤200 字），如接口约定、风格底线。",
                    },
                },
                "required": ["text"],
            },
        },
        "team_brief": {
            "type": "string",
            "description": (
                "可选：本回合团队级共识长文（≤1500 字），注入每个 worker 开局的「团队共识」"
                "上下文块；同一回合后续 delegate 仍沿用，直到你用新的 team_brief 覆盖。"
                "与 seed_notes 可并用：brief 写总述，seed_notes 钉关键决定。"
            ),
        },
        "complexity_hint": {
            "type": "string",
            "enum": ["light", "standard"],
            "description": (
                "可选，默认 standard。声明本次委派的复杂度：light = 轻量委派（单 worker、"
                "简单任务，引擎跳过不必要的协调设施），standard = 标准委派。引擎据此裁剪：light "
                "时跳过 playbook 匹配、不初始化便签墙、默认 finalize=true 行为。"
            ),
        },
        "completion_criteria": {
            "description": (
                "可选：本次委派的完成条件（引擎在全部 worker 结束后机械校验，未满足则"
                "阻止你直接收尾）。显式传入时默认 files_written（至少一名 worker 落盘文件）。"
                "代码型任务建议设 code_verified（需 code_execute / test_run 成功）。"
                "若省略且 task 含运行/打开/安装类验收语义，引擎自动推断 code_verified。"
                "custom 可附结构化描述，当前仅作提示。"
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
                            "description": "自定义完成条件的文字描述。",
                        },
                    },
                    "required": ["type"],
                },
            ],
        },
    },
}
