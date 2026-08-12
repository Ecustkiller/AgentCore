"""Local / sidecar execution-environment probe + failure markers.

Industry-aligned: before burning long runs, confirm the host can run a
minimal ``print``. Probe failures and sandbox hangs share markers so
tools / loop_controller / local-turn stats stay aligned.

Timeout redesign (定案): idle/silence is the primary kill; a high disaster
wall is only a safety net — not a「verify budget」contract.
"""

from __future__ import annotations

from agentcore.tools.sandbox.protocol import ExecutionResult

EXEC_ENV_PROBE_FAIL_MARKER = "ExecEnvProbeFailed:"
# User-facing product sentence (also ``tool_use_end.failure`` via curated code).
EXEC_ENV_PROBE_FAIL_USER_MESSAGE = (
    "本机执行环境自检未通过（连最短 print 都无法完成）。"
    "请检查本机 Python / 安全软件后重试。"
)
EXEC_ENV_PROBE_FAIL_STDERR = (
    f"{EXEC_ENV_PROBE_FAIL_MARKER} {EXEC_ENV_PROBE_FAIL_USER_MESSAGE}"
)
# Stable wire code for probe fail (distinct from idle ``exec_timeout``).
EXEC_ENV_PROBE_FAIL_CODE = "exec_env_probe_failed"

# Coarse local-turn / journal failure bucket (also accepted as client ``code``).
EXEC_TIMEOUT_CODE = "exec_timeout"
EXEC_FORCED_STOP_CODE = "exec_forced_stop"

# Outer-loop verify (test_run): idle = primary; disaster = safety net only.
EXEC_IDLE_TIMEOUT_DEFAULT_S = 60
EXEC_IDLE_TIMEOUT_INSTALL_S = 120
EXEC_DISASTER_TIMEOUT_S = 1200  # 20 minutes
_ENGINE_TIMEOUT_SLACK_SECONDS = 30

TIMEOUT_IDLE_MARKER = "Timeout: no output for"
TIMEOUT_DISASTER_MARKER = "Timeout: forced stop after"
# Legacy wall-clock wording (old clients / journals) — still classified.
TIMEOUT_LEGACY_MARKER = "Timeout: execution exceeded"


def idle_timeout_stderr(idle_seconds: int) -> str:
    return f"{TIMEOUT_IDLE_MARKER} {int(idle_seconds)}s (execution stalled)"


def disaster_timeout_stderr(wall_seconds: int) -> str:
    return f"{TIMEOUT_DISASTER_MARKER} {int(wall_seconds)}s (forced stop)"


def is_idle_timeout_text(text: str | None) -> bool:
    raw = text or ""
    return TIMEOUT_IDLE_MARKER in raw


def is_disaster_timeout_text(text: str | None) -> bool:
    """True only for the new disaster-wall marker (not legacy wall-clock text)."""
    return TIMEOUT_DISASTER_MARKER in (text or "")


def is_legacy_wall_timeout_text(text: str | None) -> bool:
    raw = text or ""
    return TIMEOUT_LEGACY_MARKER in raw and TIMEOUT_IDLE_MARKER not in raw


def is_exec_env_probe_failure(stderr_or_text: str | None) -> bool:
    """True when stderr/output carries the sticky probe-fail marker."""
    return EXEC_ENV_PROBE_FAIL_MARKER in (stderr_or_text or "")


def probe_failure_result(*, duration_ms: int = 0) -> ExecutionResult:
    """Canonical fail-fast result when the once-per-backend probe failed."""
    return ExecutionResult(
        success=False,
        stdout="",
        stderr=EXEC_ENV_PROBE_FAIL_STDERR,
        exit_code=-1,
        duration_ms=max(0, duration_ms),
    )


def looks_like_exec_timeout_text(text: str | None) -> bool:
    """Keyword / marker match for idle/legacy hang taxonomy (not disaster wall)."""
    raw = text or ""
    if not raw:
        return False
    if is_exec_env_probe_failure(raw):
        return True
    if is_idle_timeout_text(raw) or is_legacy_wall_timeout_text(raw):
        return True
    if "验证未在" in raw and "预算内完成" in raw:
        return True
    lower = raw.lower()
    return "exec_timeout" in lower or "execenvprobe" in lower.replace("_", "")
