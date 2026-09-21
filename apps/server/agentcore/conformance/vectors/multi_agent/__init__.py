"""Conformance vector builders — multi-agent orchestration scenarios.

See ``vectors/__init__.py`` for the aggregated ``VECTORS`` registry.
"""

from __future__ import annotations

from collections.abc import Callable

from agentcore.runtime.events import SSEEvent

from .async_delivery import _multi_agent_execution_detached_harvest_settle
from .auto_folder import _multi_agent_auto_folder_created
from .browser import _multi_agent_browser_session
from .coordinate import _multi_agent_coordination_wait
from .cross_turn_append import _multi_agent_cross_turn_append
from .delegate import _multi_agent_delegate
from .delivery import _multi_agent_delivery_status_partial
from .escalation import (
    _multi_agent_blocking_escalate,
    _multi_agent_blocking_escalate_pending,
    _multi_agent_escalation,
)
from .mlr_debate_acts import _multi_agent_mlr_debate_acts
from .multi_lens_research import _multi_agent_multi_lens_research
from .revision import _multi_agent_plan_revised
from .run_control import (
    _multi_agent_run_redirect_hot,
    _multi_agent_run_skipped_cascade,
)

VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "multi_agent_execution_detached_harvest_settle": (
        "批次4·detached settle：execution_detached → execution_completed → 收口回合终稿",
        _multi_agent_execution_detached_harvest_settle,
    ),
    "multi_agent_auto_folder_created": (
        "裸聊写盘自动建文件夹（§5.4）：auto_folder_created DURABLE → autoFolder 投影"
        "（对话内不渲染落点条；不挂起回合）",
        _multi_agent_auto_folder_created,
    ),
    "multi_agent_delegate": ("多 Agent：委派 2 队员，runs 树 + 进度 + 总账", _multi_agent_delegate),
    "multi_agent_browser_session": (
        "浏览器：worker 用 browser_*（navigate→snapshot→click→screenshot），"
        "每步 tool_use_end.display 携 kind:browser 契约 + 关键帧引用，折入 run.process",
        _multi_agent_browser_session,
    ),
    "multi_agent_cross_turn_append": (
        "跨回合协作图续接：m1 建图完成 → m2 同人续派新 execution_id + prev_execution_id=exec1 → "
        "追加批收口；进度分母只含本图",
        _multi_agent_cross_turn_append,
    ),
    "multi_agent_multi_lens_research": (
        "多 Agent·多视角深度调研幕1：delegate → 4 透镜并行流式 → "
        "汇总分析师落盘综述；开辩由用户点名",
        _multi_agent_multi_lens_research,
    ),
    "multi_agent_mlr_debate_acts": (
        "幕1 多视角调研后，新回合开辩（新图接上幕）",
        _multi_agent_mlr_debate_acts,
    ),
    "multi_agent_coordination_wait": (
        "StatusStrip 报 n/m，细节在节点",
        _multi_agent_coordination_wait,
    ),
    "multi_agent_delivery_status_partial": (
        "交付状态结构化：delivery_status DURABLE → deliveryStatus（同 execution_id 保最新；"
        "已交付文件 + 缺口 + bind_local_folder 行动项随卡重建）",
        _multi_agent_delivery_status_partial,
    ),
    "multi_agent_run_skipped_cascade": (
        "多 Agent·未执行收口：级联跳过 run_skipped(cascade) + graceful abort run_skipped(abort)，"
        "节点折 skipped「未执行」而非永久排队",
        _multi_agent_run_skipped_cascade,
    ),
    "multi_agent_run_redirect_hot": (
        "多 Agent·跑一半改方向·热续写：已有 partial 产出 → cancel(reason=redirect) + continue_run 修订子节点（r1 cancelled、r1_rev1 completed、r2 completed、无 _redir）",
        _multi_agent_run_redirect_hot,
    ),
    "multi_agent_plan_revised": ("多 Agent：自主再绑定「计划已调整」轻痕迹（plan_revised 折 bind/steer 到节点 revised）", _multi_agent_plan_revised),
    "multi_agent_escalation": ("多 Agent：worker 升级实时可见（run_escalation 折到节点 escalations，非阻塞）", _multi_agent_escalation),
    "multi_agent_blocking_escalate": ("多 Agent：阻塞式求决策 答复路径（escalation_required→pending→resolved，回合不 paused）", _multi_agent_blocking_escalate),
    "multi_agent_blocking_escalate_pending": ("多 Agent：阻塞式求决策 进行中（escalation_required 后挂起，回合仍 running、非 paused）", _multi_agent_blocking_escalate_pending),
}
