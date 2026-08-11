"""Coarse ``ToolCallFact.code`` derivation (kept out of ``tool_exec_parallel``)."""

from __future__ import annotations

from agentcore.runtime.loop_controller import ERROR_CLASS_VALIDATION, ToolAttempt


def tool_call_fact_code(attempt: ToolAttempt) -> str:
    """Coarse failure code for ``ToolCallFact`` (empty when unknown / success)."""
    if attempt.success:
        return ""
    meta = attempt.meta or {}
    raw = meta.get("code")
    code = raw.strip() if isinstance(raw, str) else ""
    tool = (attempt.tool_name or "").strip()
    # Git wall-clock timeout must not collide with exec idle hang buckets.
    if tool == "git" and code == "timeout":
        return "git_timeout"
    if code:
        return code
    if attempt.parse_failure or attempt.contract_failure:
        return "schema"
    if meta.get("error_class") == ERROR_CLASS_VALIDATION:
        return "schema"
    return ""
