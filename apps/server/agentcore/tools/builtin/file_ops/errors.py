"""Workspace error / ToolResult mapping for file_ops tools."""

from __future__ import annotations

import time
from typing import Any

from agentcore.tools.protocol import ToolResult
from agentcore.workspace.limits import (
    FILE_TOO_LARGE_DETAIL,
    OFFICE_EXTRACT_MAX_BYTES,
    WORKSPACE_READ_MAX_BYTES,
    channel_dead_error_message,
    channel_dead_retire_metadata,
    is_channel_dead_detail,
    is_file_too_large_detail,
    is_liveness_timeout_detail,
    op_liveness_timeout_metadata,
)
from agentcore.workspace.protocol import WorkspaceError


def _error(
    error: str,
    start: float,
    *,
    contract_failure: bool = False,
    metadata: dict[str, Any] | None = None,
) -> ToolResult:
    """Build a failed ToolResult with elapsed timing.

    ``contract_failure`` marks a self-correctable argument-contract rejection (e.g. a
    concurrent-write collision the model fixes by renaming) so the run-scoped tool
    circuit breaker skips normal failure tallies — see
    :class:`~agentcore.tools.protocol.ToolResult`. Explicit ``retire_tools`` in
    ``metadata`` still hard-disables named tools (e.g. workspace channel dead).
    """
    return ToolResult(
        tool_call_id="",
        success=False,
        output="",
        error=error,
        duration_ms=int((time.monotonic() - start) * 1000),
        contract_failure=contract_failure,
        metadata=dict(metadata or {}),
    )


def _file_too_large_error(path: str, start: float) -> ToolResult:
    """Capacity contract: oversized whole-file read (cloud + local share detail)."""
    max_mib = WORKSPACE_READ_MAX_BYTES // (1024 * 1024)
    return _error(
        (
            f"`{path}` {FILE_TOO_LARGE_DETAIL}（上限 {max_mib} MiB）。"
            "请改用 offset/limit 精读、grep 定位后局部读，或请用户提供更小片段 / 先转文本；"
            "禁止原样重试整文件读取。"
        ),
        start,
        contract_failure=True,
        metadata={"capacity_contract": "bytes"},
    )


def _office_extract_budget_error(path: str, size: int, start: float) -> ToolResult:
    """Capacity contract: Office/PDF extract cost pre-check (avoid burning liveness)."""
    max_mib = OFFICE_EXTRACT_MAX_BYTES // (1024 * 1024)
    size_mib = max(1, (size + 1024 * 1024 - 1) // (1024 * 1024))
    return _error(
        (
            f"`{path}` 体积约 {size_mib} MiB，超过透明抽取预算（{max_mib} MiB）。"
            "请请用户提供更小文件、先转 `.md`/文本后再 file_read，或改用已有 "
            "attachments 旁路摘要；禁止原样重试抽取。"
        ),
        start,
        contract_failure=True,
        metadata={"capacity_contract": "extract_bytes"},
    )


def _liveness_workspace_error(detail: str, start: float) -> ToolResult:
    """Sticky channel-dead: family retire + steer (after consecutive settle timeouts)."""
    return _error(
        channel_dead_error_message(detail),
        start,
        metadata=channel_dead_retire_metadata(),
    )


def _op_liveness_timeout_error(detail: str, start: float) -> ToolResult:
    """Single-op settle timeout: fail this call only (no family sticky / notice)."""
    return _error(
        (
            f"本地工作区通道操作超时（活性挂起）：{detail}。"
            "请缩小范围或换策略后重试；禁止原样重试同一操作。"
        ),
        start,
        metadata=op_liveness_timeout_metadata(),
    )


def _maybe_channel_dead_error(exc: WorkspaceError, start: float) -> ToolResult | None:
    """Map channel liveness failures: sticky-dead vs single-op settle timeout."""
    detail = str(exc)
    if is_channel_dead_detail(detail):
        return _liveness_workspace_error(detail, start)
    if is_liveness_timeout_detail(detail):
        return _op_liveness_timeout_error(detail, start)
    return None


def _map_workspace_read_error(exc: WorkspaceError, *, path: str, start: float) -> ToolResult:
    """Map backend read failures to capacity vs liveness vs generic I/O."""
    detail = str(exc)
    if is_file_too_large_detail(detail):
        return _file_too_large_error(path, start)
    dead = _maybe_channel_dead_error(exc, start)
    if dead is not None:
        return dead
    return _error(f"读取文件失败：{exc}", start)


def _file_read_path_ceiling_error(error: str, start: float) -> ToolResult:
    """Reject a same-path over-cap read (path-scoped; does not retire ``file_read``)."""
    return _error(
        error,
        start,
        contract_failure=True,
    )


def _outside_workspace_msg(path: str, *, location: str | None = None) -> str:
    """Actionable OutsideWorkspace text.

    Path contract lives in ``normalize_workspace_path`` / ``resolve_safe_path``;
    this message only points at remaining rejects (true out-of-root absolutes).

    On cloud (``location=server``), redirect to Composer import / Git —
    do not teach bind/open_local as the product path.
    """
    relative_fix = (
        "请使用工作区相对路径（如 AgentCore/文档/research/report.md；"
        "`.` 或裸 `/` 表示整仓）；勿使用工作区外的绝对路径（如 /etc、盘符）。"
    )
    if location == "server":
        return (
            f"路径 '{path}' 超出了工作区范围。"
            "若要把该本机目录进产品工作区：**推荐**引导 Composer「导入到云 / 连接 Git」；"
            "仅当用户明确要求新建云项目时才用 create_project"
            "（禁止为过写盘闸而建；裸聊写盘缺桌由运行时自动建云桌）；"
            "本机传统 open_local_project / register_local_project / "
            "bind_local_folder 合法非默认（≠离线）。"
            f"若本意是工作区内文件：{relative_fix}"
        )
    return f"路径 '{path}' 超出了工作区范围。{relative_fix}"

