"""Tool approval gate settings."""

from pydantic import BaseModel, Field


class ApprovalSettings(BaseModel):
    approval_gate_enabled: bool = True
    # 提问确认交互统一 D2：默认 15 分钟墙钟，一张没人处理的审批卡不再把整回合
    # 无限挂起；超时走既有 DENY 默认决策并留审计。运维可改，None 恢复无限等。
    approval_timeout_seconds: float | None = 900.0
    # Per-tool approval wait ceilings; unset tools fall back to approval_timeout_seconds.
    # 默认清空（不再对 write 设 900s）；运维可配置。
    approval_timeout_overrides: dict[str, float] = Field(default_factory=dict)

    def approval_timeout_for(self, tool_name: str) -> float | None:
        if tool_name in self.approval_timeout_overrides:
            return self.approval_timeout_overrides[tool_name]
        return self.approval_timeout_seconds
