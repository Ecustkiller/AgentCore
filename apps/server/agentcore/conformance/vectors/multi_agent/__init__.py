"""Conformance vector builders — multi-agent orchestration scenarios.

See ``vectors/__init__.py`` for the aggregated ``VECTORS`` registry.
"""

from __future__ import annotations

from collections.abc import Callable

from agentcore.runtime.events import SSEEvent

from .context import _multi_agent_captain_context, _multi_agent_received_context
from .delegate import (
    _multi_agent_delegate,
    _multi_agent_worker_deliverable_reset,
    _multi_agent_worker_failed_debrief,
    _multi_agent_worker_output_reset,
    _multi_agent_worker_process_timeline,
    _multi_agent_worker_tool,
)
from .escalation import (
    _multi_agent_blocking_escalate,
    _multi_agent_blocking_escalate_multi,
    _multi_agent_blocking_escalate_pending,
    _multi_agent_blocking_escalate_timeout,
    _multi_agent_ceo_arbitrate_escalate,
    _multi_agent_ceo_arbitrate_escalate_via_user,
    _multi_agent_escalation,
)
from .interjection import (
    _multi_agent_user_interjection_handled,
    _multi_agent_user_interjection_queued,
    _multi_agent_user_interjection_with_attachments,
)
from .revision import (
    _multi_agent_lead_subplan_bind_replan,
    _multi_agent_lead_subplan_scope_steer,
    _multi_agent_multi_batch,
    _multi_agent_multi_batch_disjoint,
    _multi_agent_plan_revised,
    _multi_agent_redelegate_continuation,
    _multi_agent_revision,
)
from .run_control import (
    _multi_agent_run_redirect_cold_fallback,
    _multi_agent_run_redirect_hot,
    _multi_agent_run_redirect_ignored,
    _multi_agent_run_skipped_cascade,
    _multi_agent_run_stop_cancels_workers,
)
from .team_notes import (
    _multi_agent_coordinate,
    _multi_agent_team_notes,
    _multi_agent_team_notes_amended,
    _multi_agent_team_notes_ceo_seed,
)

VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "multi_agent_user_interjection_handled": (
        "协调插话入图：user_interjection(delivered) → update_synthesis，折到 userInterjections",
        _multi_agent_user_interjection_handled,
    ),
    "multi_agent_user_interjection_queued": (
        "协调插话转排队：user_interjection delivered→queued（同 id 保最新）+ queue_user_message",
        _multi_agent_user_interjection_queued,
    ),
    "multi_agent_user_interjection_with_attachments": (
        "协调带附件插话：user_interjection(delivered) 携带 attachments 元数据 → userInterjections",
        _multi_agent_user_interjection_with_attachments,
    ),
    "multi_agent_delegate": ("多 Agent：委派 2 队员，runs 树 + 进度 + 总账", _multi_agent_delegate),
    "multi_agent_coordinate": (
        "刷新重建（P2）：协调模式 team_synthesis_preview DURABLE → teamSynthesisPreview（同 key 保最新）",
        _multi_agent_coordinate,
    ),
    "multi_agent_team_notes": (
        "多 Agent·通·便签墙：并行队员贴 decision/heads_up/claim 便签，折到 teamNotes（按序去重，与图节点正交）",
        _multi_agent_team_notes,
    ),
    "multi_agent_team_notes_amended": (
        "多 Agent·通·便签墙·改写/作废：队员 改写(update)/作废(void) 自己贴过的便签，目标便签标 superseded/voided",
        _multi_agent_team_notes_amended,
    ),
    "multi_agent_team_notes_ceo_seed": (
        "多 Agent·通·便签墙 Phase 2：CEO seed_notes（source=ceo）+ team_brief 注入 worker run_context",
        _multi_agent_team_notes_ceo_seed,
    ),
    "multi_agent_worker_failed_debrief": (
        "多 Agent：worker 未过契约（run_failed）但调 handoff 交了交接简报——失败节点也 surface debrief",
        _multi_agent_worker_failed_debrief,
    ),
    "multi_agent_run_skipped_cascade": (
        "多 Agent·未执行收口：级联跳过 run_skipped(cascade) + graceful abort run_skipped(abort)，"
        "节点折 skipped「未执行」而非永久排队",
        _multi_agent_run_skipped_cascade,
    ),
    "multi_agent_run_redirect_ignored": (
        "多 Agent·跑一半改方向·忽略路径：改方向来不及应用（r1 确定性失败），忽略+接受走审计/REST 带外，wire 投影保持干净（r1 failed、并行 r2 completed、1/2、无幻影重跑节点）",
        _multi_agent_run_redirect_ignored,
    ),
    "multi_agent_run_stop_cancels_workers": (
        "多 Agent·整轮 stop：in-flight worker 均 run_cancelled(reason=stop)，无热/冷 follow-up 节点，回合 cancelled",
        _multi_agent_run_stop_cancels_workers,
    ),
    "multi_agent_run_redirect_hot": (
        "多 Agent·跑一半改方向·热续写：已有 partial 产出 → cancel(reason=redirect) + continue_run 修订子节点（r1 cancelled、r1_rev1 completed、r2 completed、无 _redir）",
        _multi_agent_run_redirect_hot,
    ),
    "multi_agent_run_redirect_cold_fallback": (
        "多 Agent·跑一半改方向·冷诚实回落：空产出 → cancel(reason=redirect) + _redir 接手（r1 cancelled、r1_redir completed+replacesRunId=r1、r2 completed）",
        _multi_agent_run_redirect_cold_fallback,
    ),
    "multi_agent_worker_tool": ("多 Agent：worker 工具调用 + run_tool_progress 实时态", _multi_agent_worker_tool),
    "multi_agent_worker_process_timeline": (
        "多 Agent：worker per-run process 时间线交错（思考→工具→正文），live/回放同源",
        _multi_agent_worker_process_timeline,
    ),
    "multi_agent_worker_output_reset": (
        "多 Agent：交付前核验回炉 worker 对偶 run_output_reset 丢弃违规版 worker 草稿、保留思考、重写修正版",
        _multi_agent_worker_output_reset,
    ),
    "multi_agent_worker_deliverable_reset": (
        "多 Agent·交付正文只留最终交付：worker 调非终止工具前的旁白 run_output_reset 清掉（落点在工具后）、保留思考、只留最终交付",
        _multi_agent_worker_deliverable_reset,
    ),
    "multi_agent_revision": ("多 Agent：同人续派（continues_run_id 合成节点）", _multi_agent_revision),
    "multi_agent_redelegate_continuation": (
        "多 Agent：delegate 带 continue_from_run_id 的同批续派（计划内节点 + continues_run_id）",
        _multi_agent_redelegate_continuation,
    ),
    "multi_agent_plan_revised": ("多 Agent：自主再绑定「计划已调整」轻痕迹（plan_revised 折 bind/steer 到节点 revised）", _multi_agent_plan_revised),
    "multi_agent_lead_subplan_bind_replan": (
        "多 Agent·嵌套 lead 在自己子计划上晚定稿续跑（受监督子计划 B：同 execution_id 合并子图 + lead 自主 replan bind 折到子节点）",
        _multi_agent_lead_subplan_bind_replan,
    ),
    "multi_agent_lead_subplan_scope_steer": (
        "多 Agent·嵌套 lead 据子队员 scope 偏离操舵子计划（受监督子计划 B 自底向上：run_escalation 折子节点 + lead 自主 replan steer 折子节点）",
        _multi_agent_lead_subplan_scope_steer,
    ),
    "multi_agent_multi_batch": ("多 Agent：同回合两批 delegate（合并 + 累计进度）", _multi_agent_multi_batch),
    "multi_agent_multi_batch_disjoint": (
        "多 Agent：同回合两批 delegate、跨批无 depends_on（两坨独立任务线；第二批中途追加）",
        _multi_agent_multi_batch_disjoint,
    ),
    "multi_agent_escalation": ("多 Agent：worker 升级实时可见（run_escalation 折到节点 escalations，非阻塞）", _multi_agent_escalation),
    "multi_agent_blocking_escalate": ("多 Agent：阻塞式求决策 答复路径（escalation_required→pending→resolved，回合不 paused）", _multi_agent_blocking_escalate),
    "multi_agent_blocking_escalate_timeout": ("多 Agent：阻塞式求决策 墙钟超时（escalation_resolved status=timed_out，按假设续跑）", _multi_agent_blocking_escalate_timeout),
    "multi_agent_blocking_escalate_pending": ("多 Agent：阻塞式求决策 进行中（escalation_required 后挂起，回合仍 running、非 paused）", _multi_agent_blocking_escalate_pending),
    "multi_agent_blocking_escalate_multi": ("多 Agent：阻塞式求决策 同一 worker 串行多次升级（多升级 escalations[]，逐条结算）", _multi_agent_blocking_escalate_multi),
    "multi_agent_ceo_arbitrate_escalate": (
        "多 Agent·协调：CEO 仲裁阻塞 escalate（awaiting=ceo → resolve 直裁，arbitrated_by=ceo）",
        _multi_agent_ceo_arbitrate_escalate,
    ),
    "multi_agent_ceo_arbitrate_escalate_via_user": (
        "多 Agent·协调：CEO 经用户转交后再 resolve（arbitrated_by=ceo, via_user=true）",
        _multi_agent_ceo_arbitrate_escalate_via_user,
    ),
    "multi_agent_received_context": ("多 Agent：收到的上下文（run_context 三通道 + 依赖块溯源/保真度）", _multi_agent_received_context),
    "multi_agent_captain_context": ("多 Agent：CEO 收到的上下文路由回合级（captain 节点 receivedContext 恒空）+ worker 折到节点", _multi_agent_captain_context),
}
