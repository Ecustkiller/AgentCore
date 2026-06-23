"""Tool approval gate settings."""

from pydantic import BaseModel


class ApprovalSettings(BaseModel):
    approval_gate_enabled: bool = True
    approval_timeout_seconds: float = 300.0
