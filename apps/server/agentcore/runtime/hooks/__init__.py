"""Opt-in lifecycle hooks (生成 / 最后修订 2026-11-04).

对外只暴露这四个入口；策略 / 命令执行细节都在 ``runner.py``。
"""

from .runner import (
    HOOK_CAPABILITIES,
    HookVerdict,
    drain_post_hooks,
    run_pre_tool_hooks,
    schedule_post_tool_hooks,
    tool_hook_payload,
)

__all__ = [
    "HOOK_CAPABILITIES",
    "HookVerdict",
    "drain_post_hooks",
    "run_pre_tool_hooks",
    "schedule_post_tool_hooks",
    "tool_hook_payload",
]
