"""Empty-delegate contract reject copy — owned by runtime, not the tool adapter.

``tools.builtin.delegate.schema`` re-exports these so the empty-tasks
reject (server + desktop mirror) stays on one string. The copyable
skeleton is not advertised on the per-turn schema.
"""

from __future__ import annotations

# 弱模型可抄的顶层 tasks（role/task；可选 artifacts 不进抄本）。
# 只在缺 tasks 拒收回执，不进每轮 schema。
HANDWRITTEN_TASKS_SKELETON = (
    '{"tasks":[{"role":"角色","task":"目标+边界+验收"}]}'
)
EMPTY_DELEGATE_MSG = (
    "delegate 缺 tasks：默认顶层放非空 `tasks`，"
    f"可抄：{HANDWRITTEN_TASKS_SKELETON}。"
)


def is_empty_delegate_error(error: str | None) -> bool:
    """True when a failed delegate result is the empty-tasks contract reject."""
    if not error:
        return False
    return error == EMPTY_DELEGATE_MSG or error.startswith("delegate 缺 tasks")
