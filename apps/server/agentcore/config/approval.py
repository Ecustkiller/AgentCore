"""Tool approval gate settings."""

from pydantic import BaseModel, Field


def _default_approval_timeout_overrides() -> dict[str, float]:
    # file_write often carries long-form drafts (e.g. paper sections); 5 min was too
    # tight and surfaced as approval.timeout → run.failed.
    return {"file_write": 900.0}


class ApprovalSettings(BaseModel):
    approval_gate_enabled: bool = True
    approval_timeout_seconds: float = 300.0
    # Per-tool approval wait ceilings; unset tools fall back to approval_timeout_seconds.
    approval_timeout_overrides: dict[str, float] = Field(
        default_factory=_default_approval_timeout_overrides
    )

    def approval_timeout_for(self, tool_name: str) -> float:
        return self.approval_timeout_overrides.get(tool_name, self.approval_timeout_seconds)
