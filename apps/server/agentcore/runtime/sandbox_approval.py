"""Sandbox → approval policy table (安全权限与治理 §三 / §五).

Maps the workspace execution environment to whether GRANTABLE *execution-class*
tools still need a human approval prompt. File-mutation tools keep their own
gate posture (local: gated; cloud workers historically ungated via no gate).
"""

from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING

from agentcore.config import settings

if TYPE_CHECKING:
    from agentcore.workspace.protocol import WorkspaceBackend


class ExecutionApprovalPosture(StrEnum):
    """Whether execution-class tools (``code_execute`` / ``test_run``) need approval."""

    REQUIRES_AUTH = "requires_auth"  # local subprocess — user must authorize
    AUTO_PASS = "auto_pass"  # cloud gVisor true isolation — auto-approve
    UNAVAILABLE = "unavailable"  # cloud without sandbox — tools not registered


def execution_approval_posture(backend: WorkspaceBackend | None) -> ExecutionApprovalPosture:
    """Resolve the sandbox → execution-approval cell for this workspace."""
    if backend is None:
        return ExecutionApprovalPosture.REQUIRES_AUTH
    if backend.location == "local":
        return ExecutionApprovalPosture.REQUIRES_AUTH
    # Cloud (location=server): no real sandbox → tools withheld at registry;
    # gVisor on → true isolation, execution auto-passes.
    if settings.gvisor_enabled:
        return ExecutionApprovalPosture.AUTO_PASS
    return ExecutionApprovalPosture.UNAVAILABLE


def worker_gate_applies(backend: WorkspaceBackend | None) -> bool:
    """Whether delegated workers share the turn ApprovalGate.

    Local subprocess: yes (real machine). Cloud: no — either tools are withheld
    (no sandbox) or gVisor isolates execution (AUTO_PASS); file ops run in the
    per-user server workspace without a per-call gate.
    """
    return backend is not None and backend.location == "local"


def execution_tool_auto_passes(backend: WorkspaceBackend | None, tool_name: str) -> bool:
    """True when an execution-class tool should skip the approval prompt."""
    if tool_name not in ("code_execute", "test_run"):
        return False
    return execution_approval_posture(backend) is ExecutionApprovalPosture.AUTO_PASS
