"""Conformance vector builders — interactive gate pause/continue scenarios.

See ``vectors/__init__.py`` for the aggregated ``VECTORS`` registry.
"""

from __future__ import annotations

from collections.abc import Callable

from agentcore.runtime.events import (
    FinishReason,
    SSEEvent,
    approval_required,
    approval_resolved,
    checkpoint_required,
    checkpoint_resolved,
    content_delta,
    execution_completed,
    message_end,
    message_start,
    reasoning_delta,
    run_completed,
    run_plan,
    run_started,
    tool_use_end,
    tool_use_start,
)

from ._common import _CONV, _COST, _USAGE


def _approval_paused() -> list[SSEEvent]:
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我需要运行代码。"),
        approval_required(
            approval_id="tc1",
            conversation_id=_CONV,
            tool_call_id="tc1",
            tool_name="code_execute",
            arguments={"code": "print(1)"},
        ),
    ]

def _approval_resolved_continue() -> list[SSEEvent]:
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我需要运行代码。"),
        approval_required(
            approval_id="tc1",
            conversation_id=_CONV,
            tool_call_id="tc1",
            tool_name="code_execute",
            arguments={"code": "print(1)"},
        ),
        approval_resolved(approval_id="tc1", tool_call_id="tc1", decision="approve"),
        tool_use_start("tc1", "code_execute", {"code": "print(1)"}),
        tool_use_end("tc1", "code_execute", success=True, output="1\n"),
        content_delta("运行结果是 1。"),
        message_end(FinishReason.END_TURN, input_tokens=900, output_tokens=80, cost=_COST),
    ]


def _single_agent_checkpoint() -> list[SSEEvent]:
    """单聊·检查点 (ask_user blocking=true)：CEO 想清楚后向用户拍板、暂停回合。检查点在时间线
    **原位**落一个 `checkpoint` 标记（卡片正文另路 fold，按 checkpoint_id 取回），回合停在
    checkpoint_required（无 message_end）→ pendingInteraction=checkpoint、status=paused。
    验「检查点不再压到气泡底部、而是回到它真实发生的时序位」。"""
    return [
        message_start("m1", conversation_id=_CONV),
        reasoning_delta("这个需求有歧义，先问清楚。"),
        content_delta("开始前我确认一下方向："),
        checkpoint_required(
            checkpoint_id="cp1",
            conversation_id=_CONV,
            question="先做 A 还是 B？\n两条路线各有取舍。",
            intent="decision",
        ),
    ]

def _single_agent_checkpoint_finalized() -> list[SSEEvent]:
    """单聊·检查点【收口即终止】(②)：ask_user(blocking) 落帧后【不再
    挂在内存 Future】，回合直接以 ``message_end(finish_reason=paused)`` 收口——流到此【终止】（对照
    ``_single_agent_checkpoint`` 的「停在 ``checkpoint_required``、无 ``message_end``」挂起态）。
    关键断言：``status`` 仍 ``paused``、``pendingInteraction`` 仍 checkpoint（同一张 resume 卡），但
    ``finishReason="paused"`` + ``cost`` 落账——客户端据「流以 paused 收尾」渲成单张 resume 卡（统一
    冷路 ``POST .../resume``，根除 live/durable 双态）。验「终止式挂起 == 挂起态的同一恢复面」。"""
    return [
        *_single_agent_checkpoint(),
        message_end(FinishReason.PAUSED, input_tokens=1900, output_tokens=210, cost=_COST),
    ]

def _single_agent_checkpoint_resolved() -> list[SSEEvent]:
    """单聊·检查点【冷路恢复】(② resume)：ask_user(blocking) 落帧暂停后，用户经
    ``POST .../resume`` 拍板续跑——``checkpoint_resolved`` 清掉 pendingInteraction、status 从
    paused 回 running，回合继续产出并正常 ``end_turn`` 收尾。对照 ``_single_agent_checkpoint``
    （停在 ``checkpoint_required`` 的挂起态）验「同一张 resume 卡在续跑后关闭、回合跑到底」。"""
    return [
        *_single_agent_checkpoint(),
        checkpoint_resolved(checkpoint_id="cp1", decision="continue"),
        content_delta("好，按 A 推进。"),
        content_delta(" 已完成初稿。"),
        message_end(FinishReason.END_TURN, input_tokens=2100, output_tokens=260, cost=_COST),
    ]


def _proposal_choice_checkpoint() -> list[SSEEvent]:
    """单聊·方案挑选走普通 ask_user（intent=decision）：单选 choice，权衡写进 label。"""
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("有三条可行路线，请挑一条："),
        checkpoint_required(
            checkpoint_id="cp_pick",
            conversation_id=_CONV,
            question="选哪条方案推进？",
            questions=[
                {
                    "id": "q0",
                    "prompt": "选哪条方案？",
                    "kind": "choice",
                    "multiple": False,
                    "default": "",
                    "options": [
                        {"label": "方案 A：快速原型（一周可验证）"},
                        {"label": "方案 B：稳妥重构（两周，债务更少）"},
                        {"label": "方案 C：外包试点（推荐）"},
                    ],
                }
            ],
            intent="decision",
        ),
        message_end(FinishReason.PAUSED, input_tokens=1800, output_tokens=120, cost=_COST),
    ]


def _risk_choice_checkpoint() -> list[SSEEvent]:
    """单聊·风险勾选走普通 ask_user（intent=decision）：多选 choice，权衡写进 label。"""
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("落地前请勾选要一并处理的风险："),
        checkpoint_required(
            checkpoint_id="cp_risk",
            conversation_id=_CONV,
            question="哪些风险要在本轮处理？",
            questions=[
                {
                    "id": "q0",
                    "prompt": "勾选要处理的风险",
                    "kind": "choice",
                    "multiple": True,
                    "default": "",
                    "options": [
                        {"label": "[高] 密钥轮换（推荐）：生产密钥仍是默认值"},
                        {"label": "[中] 备份校验：近 30 天备份未做恢复演练"},
                        {"label": "回滚演练"},
                    ],
                }
            ],
            intent="decision",
        ),
        message_end(FinishReason.PAUSED, input_tokens=1900, output_tokens=140, cost=_COST),
    ]


def _carrier_means_consult_smartart_boundary() -> list[SSEEvent]:
    """载体/手段顾问·能力边界前置（种子 A）：用户要 Word 图形 SmartArt 组织图 → 先诚实说做不到
    图形 SmartArt，再短 ask 推荐可交替代（交互 HTML / PPT / Word 文本层级）并保留「仍要 Word
    文字版」；禁先答笼统「可以」再缩水。对照 ``proposal_choice_checkpoint``（选项名带「（推荐）」）。"""
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta(
            "Word 里做不出带框连线的图形 SmartArt 组织架构图；"
            "我这边能交的是文本层级 docx、PPT 连线版，或可折叠交互 HTML。"
        ),
        checkpoint_required(
            checkpoint_id="cp_carrier_smartart",
            conversation_id=_CONV,
            question=(
                "组织架构图用哪种可交形态？\n"
                "能力边界前置：图形 SmartArt 做不到；推荐更适合的载体，"
                "仍可坚持 Word 文字版。"
            ),
            questions=[
                {
                    "id": "q0",
                    "prompt": "选哪种可交形态？",
                    "kind": "choice",
                    "multiple": False,
                    "default": "交互 HTML 组织图（可折叠）（推荐）",
                    "options": [
                        {
                            "label": "交互 HTML 组织图（可折叠）（推荐）",
                            "detail": "宽树也能看全",
                        },
                        {
                            "label": "PPT 带框连线版",
                            "detail": "可打开编辑的图形页",
                        },
                        {
                            "label": "Word 文本层级版（仍要 Word）",
                            "detail": "缩进/表格文字版，非图形 SmartArt",
                        },
                    ],
                }
            ],
            intent="decision",
        ),
        message_end(FinishReason.PAUSED, input_tokens=1800, output_tokens=140, cost=_COST),
    ]


def _carrier_means_consult_html_org_tree() -> list[SSEEvent]:
    """载体/手段顾问·次优载体/框架锁定（种子 B）：用户要极宽组织树「只翻译、框架不变、存 HTML」
    → 短对齐提示静态 1:1 难看全，推荐折叠/分区等更好呈现，并保留「仍按原样 HTML」；非盲跟开做。
    对照 ``carrier_means_consult_smartart_boundary``（能力边界）与 ``proposal_choice_checkpoint``。"""
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta(
            "这棵组织树很宽，静态 HTML 1:1 照搬几乎看不全；"
            "更适合可折叠树或按部门分区，也可仍按原样 HTML。"
        ),
        checkpoint_required(
            checkpoint_id="cp_carrier_html_tree",
            conversation_id=_CONV,
            question=(
                "组织树 HTML 用哪种呈现？\n"
                "次优载体短对齐：框架可保，呈现建议改；坚持原样静态 HTML 亦可。"
            ),
            questions=[
                {
                    "id": "q0",
                    "prompt": "选哪种 HTML 呈现？",
                    "kind": "choice",
                    "multiple": False,
                    "default": "可折叠树 HTML（推荐）",
                    "options": [
                        {
                            "label": "可折叠树 HTML（推荐）",
                            "detail": "保留层级，默认收拢便于看全",
                        },
                        {
                            "label": "按部门分区多页 HTML",
                            "detail": "框架不变，分页降低横向溢出",
                        },
                        {
                            "label": "仍按原样静态 HTML 1:1",
                            "detail": "只翻译、不改框架，接受裁切/滚动",
                        },
                    ],
                }
            ],
            intent="decision",
        ),
        message_end(FinishReason.PAUSED, input_tokens=1800, output_tokens=140, cost=_COST),
    ]


def _ceo_delegate_two_planned() -> list[SSEEvent]:
    """CEO 已 announce 两人编制（run_plan），队员尚未 start。给杀进程 / 二次挂起向量当前缀。"""
    agents = [
        {
            "id": "w1",
            "role": "调研",
            "thinking": True,
        },
        {
            "id": "w2",
            "role": "撰写",
            "thinking": True,
        },
    ]
    plan_runs = [
        {"id": "r1", "agent_id": "w1", "task": "调研方案", "depends_on": []},
        {"id": "r2", "agent_id": "w2", "task": "写初稿", "depends_on": ["r1"]},
    ]
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来安排团队。"),
        tool_use_start(
            "dc1",
            "delegate",
            {"tasks": [{"role": "调研"}, {"role": "撰写"}], "coordinate": False},
        ),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="构建 X",
            agents=agents,
            runs=plan_runs,
        ),
    ]


def _execution_completed_gate_still_pending() -> list[SSEEvent]:
    """执行完成 + 门禁仍挂起：队员已齐、``execution_completed(status=completed)`` 已落，
    但 CEO 仍以 ``checkpoint_required`` 阻塞，并以 ``message_end(paused)`` 收口。

    钉死 TurnStatus 判定序（桌面 / oracle）：finishReason → error → gate pending →
    running。``execution_completed`` 只校正协作图节点，不得把回合判成 completed
    （手机 fold 曾把该帧放在优先级最高位，挂起卡被吞成已完成）。
    """
    agents = [{"id": "w1", "role": "调研", "thinking": True}]
    plan_runs = [{"id": "r1", "agent_id": "w1", "task": "出方案", "depends_on": []}]
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("团队已交付，请确认是否按此方案推进。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="出方案",
            agents=agents,
            runs=plan_runs,
        ),
        run_started("r1", "w1"),
        run_completed(
            "r1",
            "w1",
            output_summary="方案就绪",
            duration_ms=900,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        execution_completed(
            execution_id="exec1",
            conversation_id=_CONV,
            completed=1,
            total=1,
            status="completed",
            host_turn_id="m1",
        ),
        checkpoint_required(
            checkpoint_id="cp-after-exec",
            conversation_id=_CONV,
            question="按此方案推进吗？\n团队已交付方案。",
            intent="decision",
        ),
        message_end(FinishReason.PAUSED, input_tokens=2200, output_tokens=180, cost=_COST),
    ]


def _decision_then_kill() -> list[SSEEvent]:
    """决策后杀进程：settlement 已落、无终态 → fold 无 pending gate，status=running。

    验收（回合恢复状态机收口）：重启投影不得出现待授权卡；对应 UI 救火「继续」（已决策·执行中断）。
    """
    return [
        *_ceo_delegate_two_planned(),
        run_started("r1", "w1"),
        # 杀进程：无 message_end / 无新 gate
    ]


def _decision_then_second_gate_then_kill() -> list[SSEEvent]:
    """决策后执行中二次挂起再杀：只投影新决策卡，旧 settlement 不产生中断态双显。"""
    return [
        *_ceo_delegate_two_planned(),
        run_started("r1", "w1"),
        run_completed(
            "r1",
            "w1",
            output_summary="调研完成",
            duration_ms=900,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        checkpoint_required(
            checkpoint_id="cp-second",
            conversation_id=_CONV,
            question="调研结论你认吗？\n二次挂起",
            intent="decision",
        ),
        message_end(FinishReason.PAUSED, input_tokens=2200, output_tokens=180, cost=_COST),
    ]


VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "approval_paused": ("审批：approval_required 暂停（无 message_end）", _approval_paused),
    "approval_resolved_continue": ("审批：通过后继续到 end_turn", _approval_resolved_continue),
    "single_agent_checkpoint": ("单聊：检查点 ask_user(blocking) 在时间线原位落 checkpoint 标记 + 暂停", _single_agent_checkpoint),
    "single_agent_checkpoint_resolved": ("单聊：检查点 ask_user(blocking) 经 resume 续跑（checkpoint_resolved 清挂起→跑到 end_turn）", _single_agent_checkpoint_resolved),
    "carrier_means_consult_smartart_boundary": (
        "载体/手段顾问：Word SmartArt 能力边界前置 → 诚实做不到 + 选项名带「（推荐）」的可交替代 ask（含仍要 Word 文字版）",
        _carrier_means_consult_smartart_boundary,
    ),
}
