"""Lifecycle hooks settings (生成 / 最后修订 2026-11-04).

上游文档里 **没有任何**「不做 agent 生命周期钩子」的表述（grep ``docs/`` 的
hook 命中全是 React hooks / pre-commit hooks / 日志字段）。这是纯空白，不是
被校准掉的产品方向，所以本 fork 的 #7 补一条最小可用实现。

为什么默认关：钩子会执行**外部命令**，改变工具调用的执行面；按本 fork 原则
不覆盖上游默认行为。开关关掉时 ``run_one_tool`` 只多一次 bool 判断，
不发事件、不起子进程、不改任何返回形状。

v1 边界（详见 ``runtime/hooks/runner.py::HOOK_CAPABILITIES``）：
- 只有 ``pre_tool_use`` / ``post_tool_use``；没有 Stop / SessionStart / PreCompact；
- 命令只从**服务端环境变量**读，不是用户可配，也不是模型可调用的工具；
  若将来开放给用户配置，必须另加审批 / 白名单，不能照搬；
- ``pre`` 只能收窄：拿到 deny 就拒；拿到 allow **忽略**，绝不短路
  ``ApprovalGate`` / ``always_confirm`` / ``boundary_block_message``；
- ``post`` 只观测，不能改 ``ToolResult``；fire-and-forget，失败不拖垮回合；
- 命令失败 / 超时 / 非 JSON 一律 fail-open 记 warning；**只有明确拿到 deny 才拒**。

env（pydantic-settings 无前缀）::

    RUNTIME_HOOKS_ENABLED=1
    RUNTIME_HOOKS_DEFAULT_TIMEOUT_SECONDS=5
    RUNTIME_HOOKS_SPEC='[
      {"event":"pre_tool_use","matcher":"^write$","command":["/usr/bin/python3","/etc/nexus/guard.py"]},
      {"event":"post_tool_use","matcher":".*","command":["/usr/bin/logger"]}
    ]'
"""

from pydantic import BaseModel, Field


class RuntimeHooksSettings(BaseModel):
    # 默认关：关掉时工具执行链与上游字节一致（只多一次布尔判断）。
    runtime_hooks_enabled: bool = False

    # 单条钩子的硬超时；不设上限会拖住 tool_exec_parallel 的并发槽。
    runtime_hooks_default_timeout_seconds: float = Field(default=5.0, ge=1.0, le=30.0)

    # JSON 数组字符串；坏形状按「没配钩子」处理（fail closed），不拼半个命令。
    runtime_hooks_spec: str = ""
