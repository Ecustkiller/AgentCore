"""Deterministic task-mode hints for the CEO turn envelope.

The router is intentionally conservative. It does not remove tools or hard-force
an execution path; it gives the model one clear default for this turn while
leaving room to upgrade when the task structure demands it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

TaskMode = Literal["chat", "code_fast", "review", "team"]


@dataclass(frozen=True)
class TaskModeDecision:
    mode: TaskMode
    reason: str


_CODE_ACTION = re.compile(
    r"(修|改|实现|新增|添加|重构|调试|修复|补|迁移|升级|优化|"
    r"\bfix\b|\bimplement\b|\brefactor\b|\bdebug\b|\bpatch\b|"
    r"\badd\b|\bupdate\b|\bmigrate\b)",
    re.IGNORECASE,
)
_CODE_CONTEXT = re.compile(
    r"(代码|仓库|项目|模块|函数|类|接口|测试|构建|类型|bug|"
    r"\.py\b|\.ts\b|\.tsx\b|\.js\b|\.go\b|\.rs\b|"
    r"\bpython\b|\btypescript\b|\bjavascript\b|\bgo\b|\brust\b|"
    r"\bpytest\b|\bvitest\b|\bcode\b|\brepo\b)",
    re.IGNORECASE,
)
_REVIEW = re.compile(
    r"(审查|代码审查|架构审查|安全审查|风险评估|review\b|code review)",
    re.IGNORECASE,
)
_TEAM = re.compile(
    r"(跨模块|多个模块|全仓|所有模块|多文件|并行|分别处理|同时处理|"
    r"大规模|全面调研|多路调研|独立审查|组团|团队)",
    re.IGNORECASE,
)
_CONTINUE = re.compile(r"^(继续|接着做|开始|执行|做吧|continue|go ahead)[。！!.]*$", re.I)


def classify_task_mode(
    user_message: str,
    *,
    shared_workspace: bool = False,
) -> TaskModeDecision:
    """Classify one user turn into a conservative default execution mode."""
    text = (user_message or "").strip()
    if not text:
        return TaskModeDecision("chat", "empty")

    code_context = bool(_CODE_CONTEXT.search(text))
    code_action = bool(_CODE_ACTION.search(text))
    review = bool(_REVIEW.search(text))
    team = bool(_TEAM.search(text))

    if review and (code_context or shared_workspace):
        return TaskModeDecision(
            "team" if team else "review",
            "review_with_team_scope" if team else "review",
        )
    if team and (code_context or shared_workspace or code_action):
        return TaskModeDecision("team", "parallel_or_cross_module_scope")
    if code_action and (code_context or shared_workspace):
        return TaskModeDecision("code_fast", "single_code_action")
    if shared_workspace and _CONTINUE.match(text):
        return TaskModeDecision("code_fast", "workspace_continuation")
    return TaskModeDecision("chat", "no_code_action_signal")


def render_task_mode_block(decision: TaskModeDecision) -> str:
    """One compact per-turn mode contract; empty for ordinary chat."""
    if decision.mode == "chat":
        return ""
    if decision.mode == "code_fast":
        return (
            "<任务模式 mode=\"code_fast\">\n"
            "当前是单 Agent 快路径。默认由你直接完成定位、修改和验证；不要为了"
            "形式调用 delegate。只有在发现任务实际跨越多个独立模块、需要并行"
            "取证或独立审查时才升级 Team。完成后以实际命令和测试结果为准。\n"
            "</任务模式>"
        )
    if decision.mode == "review":
        return (
            "<任务模式 mode=\"review\">\n"
            "当前是审查路径。先读取真实代码、测试和运行结果，再给按严重度排序的"
            "结论；默认直接审查，只有需要独立并行核查时才使用 Team。\n"
            "</任务模式>"
        )
    return (
        "<任务模式 mode=\"team\">\n"
        "当前存在并行或跨模块信号。只在子任务结论可独立成立时拆开，按依赖关系"
        "组队；同文件、同契约或串行耦合的工作留在同一 Agent。\n"
        "</任务模式>"
    )
