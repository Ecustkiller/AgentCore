"""事件持久化处置的单一权威源（处置单一源 / 持久化优化 A+）。

每个 :class:`~agentcore.runtime.events.types.EventType` 必须在 :data:`EVENT_DISPOSITION`
里有且仅有一条处置声明，三选一：

- ``DURABLE``   —— 落 ``turn_journal``（事实源），reload 由 journal fold 重放。
  :data:`DURABLE_EVENT_TYPES` 即由此**派生**（取所有 DURABLE），
  ``journal_config._JOURNAL_EVENT_TYPES`` 复用它，不再手维护第二份清单。
- ``DERIVED``   —— 信息经**专用列 / 其它投影**持久化（非 journal allow-list），reload 时重建
  （如 content_delta→Message.content、title_generated→Conversation.title）。
- ``EPHEMERAL`` —— **有意不持久化**，reload 后按设计丢失（传输控制帧 / 进度心跳 /
  客户端工具请求 / 进程内交互态）。这不是「漏」，而是被显式记录的取舍。

**为什么要这张表**：历史上「哪些事件落库」散落在 allow-list（``_JOURNAL_EVENT_TYPES``）+
各投影列 + 前端 fold 的 default 分支里，新增事件极易**静默遗漏**（不声明处置也能编译通过、
也能上线，只是重载后内容凭空消失）。本表把处置收敛到一处，并由
``tests/test_event_disposition.py`` 的两道门禁守护：

1. **穷尽门禁**：``set(EventType) == set(EVENT_DISPOSITION)`` —— 新增事件不声明处置即 CI 红。
2. **DURABLE 覆盖门禁**：每个 DURABLE 必须被某条 conformance 向量覆盖，或在测试的
   ``DURABLE_VECTOR_WAIVERS`` 里显式豁免（带理由）—— 挡住「落库但从没测过重放」。

改动本表前请先读本 docstring；调整某事件处置时，同步更新其对应的落库列 / 投影 / 前端 fold。
"""

from __future__ import annotations

from enum import StrEnum

from agentcore.runtime.events.types import EventType


class Disposition(StrEnum):
    """一个事件相对于「回合重载」的持久化归属。"""

    DURABLE = "durable"
    DERIVED = "derived"
    EPHEMERAL = "ephemeral"


# EventType → (处置, 一行理由)。穷尽覆盖全部 EventType（由测试强制）。
EVENT_DISPOSITION: dict[EventType, tuple[Disposition, str]] = {
    # ---- DURABLE：落 turn_journal，reload 由 fold 重放（= 现 _JOURNAL_EVENT_TYPES） ----
    EventType.RUN_PLAN: (Disposition.DURABLE, "团队图/单体计划——重放团队结构与过程时间线的锚"),
    EventType.RUN_STARTED: (Disposition.DURABLE, "某 run 起始——重放该节点的开始"),
    EventType.RUN_CONTEXT: (Disposition.DURABLE, "派发给 run 的上下文/依赖——重放收到的上下文"),
    EventType.RUN_COMPLETED: (Disposition.DURABLE, "run 完成（含 message_final）——重放产出/发言"),
    EventType.RUN_FAILED: (Disposition.DURABLE, "run 失败——重放失败态与原因"),
    EventType.RUN_PROGRESS: (Disposition.DURABLE, "run 阶段进度里程碑——重放过程节拍"),
    EventType.BATCH_METRICS: (Disposition.DURABLE, "调度埋点量化——run-detail 诊断信息重放"),
    EventType.DEBATE_RESULT: (Disposition.DURABLE, "辩论最终裁决——重放结论"),
    EventType.TOOL_USE_START: (Disposition.DURABLE, "工具调用开始——重放工具时间线条目"),
    EventType.TOOL_USE_END: (Disposition.DURABLE, "工具调用结束（结果）——重放工具结果"),
    EventType.CHECKPOINT_REQUIRED: (Disposition.DURABLE, "检查点挂起（耐久帧）——reload 重现待裁决卡"),
    EventType.CHECKPOINT_RESOLVED: (Disposition.DURABLE, "检查点已裁决——重放裁决结果"),
    EventType.QUESTION_POSTED: (Disposition.DURABLE, "非阻断/阻断提问（耐久帧）——reload 重现提问"),
    EventType.PLAN_REVIEW_REQUIRED: (Disposition.DURABLE, "计划复核挂起（耐久帧）——reload 重现复核卡"),
    EventType.PLAN_REVIEW_RESOLVED: (Disposition.DURABLE, "计划复核已裁决——重放裁决"),
    EventType.PLAN_REVISED: (Disposition.DURABLE, "自主再绑定「计划已调整」轻痕迹——重放"),
    EventType.ESCALATION_REQUIRED: (Disposition.DURABLE, "升级请求（单一发射者）——重放升级"),
    EventType.ESCALATION_RESOLVED: (Disposition.DURABLE, "升级已处理——重放结果"),
    EventType.TEAM_NOTE_POSTED: (Disposition.DURABLE, "团队便签墙——team-notes 面板重放"),
    # ---- DERIVED：经专用列 / 其它投影持久化，reload 时重建（非 journal allow-list） ----
    EventType.CONTENT_DELTA: (Disposition.DERIVED, "正文流——最终态落 Message.content 列"),
    EventType.REASONING_DELTA: (Disposition.DERIVED, "思考流——最终态落 Message.reasoning_content 列"),
    EventType.CITATIONS: (Disposition.DERIVED, "联网来源——落 Message.citations 列"),
    EventType.MESSAGE_END: (Disposition.DERIVED, "收尾（token/finish）——落 Message.usage + finish_reason"),
    EventType.ERROR: (Disposition.DERIVED, "回合错误——落 Message.finish_reason + 错误正文（不完整回合持久化）"),
    EventType.TITLE_GENERATED: (Disposition.DERIVED, "回合后标题——回写 Conversation.title 列"),
    EventType.FOLLOWUPS_GENERATED: (
        Disposition.DERIVED,
        "回合后「下一步」chips——回写 Message.followups 列（与同胞 title 一致，reload 重现）",
    ),
    EventType.RUN_OUTPUT_DELTA: (Disposition.DERIVED, "worker 正文流——由 message_final 事实合成重放"),
    EventType.RUN_REASONING_DELTA: (Disposition.DERIVED, "worker 思考流——由 message_final 事实合成重放"),
    EventType.RUN_ESCALATION: (
        Disposition.DERIVED,
        "run 级升级实时信号——耐久记录为已落库的 ESCALATION_REQUIRED/RESOLVED + transcript 投影",
    ),
    # ---- EPHEMERAL：有意不持久化，reload 后按设计丢失（显式取舍，非漏） ----
    EventType.MESSAGE_START: (Disposition.EPHEMERAL, "回合起始控制帧——reload 即已开始，无需重放"),
    EventType.CONTENT_RESET: (Disposition.EPHEMERAL, "流内纠正（丢弃已流内容重来）——重载以最终列为准"),
    EventType.RUN_OUTPUT_RESET: (Disposition.EPHEMERAL, "run 流内纠正——重载以 message_final 为准"),
    EventType.TURN_SAVED: (Disposition.EPHEMERAL, "落库确认控制帧——reload 本身即已保存态"),
    EventType.TOOL_PROGRESS: (Disposition.EPHEMERAL, "工具参数流式心跳——传输态，工具已完成"),
    EventType.TOOL_USE_PROGRESS: (Disposition.EPHEMERAL, "工具执行阶段心跳——传输态，工具已完成"),
    EventType.RUN_TOOL_PROGRESS: (Disposition.EPHEMERAL, "run 工具进度心跳——传输态"),
    EventType.WORKSPACE_OP_REQUIRED: (Disposition.EPHEMERAL, "客户端工具请求（请求/响应交换，非回合内容）"),
    EventType.BOARD_OP_REQUIRED: (Disposition.EPHEMERAL, "白板客户端工具请求（请求/响应交换，非回合内容）"),
    EventType.BOARD_READ_REQUIRED: (Disposition.EPHEMERAL, "白板栅格化读取客户端工具请求（非回合内容）"),
    EventType.HANDOFF_SNAPSHOT_DONE: (Disposition.EPHEMERAL, "接管快照控制帧——传输态"),
    EventType.HANDOFF_JOB_STARTED: (Disposition.EPHEMERAL, "接管任务启动控制帧——传输态"),
    EventType.HANDOFF_APPLY_DONE: (Disposition.EPHEMERAL, "接管应用完成控制帧——传输态"),
    EventType.APPROVAL_REQUIRED: (
        Disposition.EPHEMERAL,
        "进程内 HITL 审批门（InteractionRegistry，超时=拒）——结果经 tool_use_* 落库，提示本身瞬态",
    ),
    EventType.APPROVAL_RESOLVED: (Disposition.EPHEMERAL, "审批门裁决——瞬态门的关闭，结果体现在后续工具事件"),
    EventType.DELEGATION_AUTHORIZATION_REQUIRED: (
        Disposition.EPHEMERAL,
        "委派级授权挂起（InteractionRegistry，超时=拒）——结果体现在后续工具事件",
    ),
    EventType.DELEGATION_AUTHORIZATION_RESOLVED: (
        Disposition.EPHEMERAL,
        "委派级授权裁决——瞬态门的关闭，结果体现在后续工具事件",
    ),
    EventType.DEBATE_ROUND_STARTED: (
        Disposition.EPHEMERAL,
        "辩论轮次开场——实时叙事覆盖层；各方发言经 debater 的 RUN_* 事实持久化",
    ),
    EventType.DEBATE_ROUND: (
        Disposition.EPHEMERAL,
        "辩论单轮——实时叙事覆盖层；各方发言经 debater 的 RUN_* 事实持久化",
    ),
    EventType.DEBATE_ROUND_DECISION_REQUIRED: (
        Disposition.EPHEMERAL,
        "辩论轮间交互裁决——进程内活跃态；断线/重启后续看+续辩的耐久化单独一轮（已约定）",
    ),
    EventType.DEBATE_ROUND_DECISION_RESOLVED: (
        Disposition.EPHEMERAL,
        "辩论轮间裁决结果——进程内活跃态；耐久化单独一轮（已约定）",
    ),
    EventType.TURN_WARNING: (
        Disposition.EPHEMERAL,
        "回合前软门禁提示（supports_tools=false）——传输态，不阻断回合",
    ),
    EventType.SIM_TICK_STARTED: (
        Disposition.EPHEMERAL,
        "模拟 tick 开始——持久化走 sim_event 表，不进 turn_journal",
    ),
    EventType.SIM_TICK_ENDED: (
        Disposition.EPHEMERAL,
        "模拟 tick 结束——持久化走 sim_event 表，不进 turn_journal",
    ),
    EventType.SIM_AGENT_ACTION: (
        Disposition.EPHEMERAL,
        "模拟居民行动——持久化走 sim_event 表，不进 turn_journal",
    ),
    EventType.SIM_AGENT_STATE: (
        Disposition.EPHEMERAL,
        "模拟居民状态快照——持久化走 sim_event 表，不进 turn_journal",
    ),
    EventType.SIM_INTERACTION: (
        Disposition.EPHEMERAL,
        "模拟结构化交互——SSE sim.interaction；sim_event 表用 conversation/trade/vote 分类",
    ),
    EventType.SIM_WORLD_EVENT: (
        Disposition.EPHEMERAL,
        "模拟世界事件——SSE sim.world_event；持久化走 sim_event 表",
    ),
    EventType.SIM_TICK_FRAME: (
        Disposition.EPHEMERAL,
        "模拟 tick 快照帧——仅回放 SSE 推送，不落 sim_event",
    ),
}


DURABLE_EVENT_TYPES: frozenset[EventType] = frozenset(
    event for event, (disposition, _reason) in EVENT_DISPOSITION.items()
    if disposition is Disposition.DURABLE
)
"""所有 DURABLE 事件——``_JOURNAL_EVENT_TYPES`` 的单一来源。"""
