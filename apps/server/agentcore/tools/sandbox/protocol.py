"""SandboxProvider Protocol for isolated code execution."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from agentcore.core.text import truncate_head_tail


@dataclass
class ExecutionRequest:
    """Request to execute code in a sandbox."""

    code: str
    language: Literal["python", "javascript", "bash"]
    timeout_seconds: int = 30
    memory_limit_mb: int = 256
    stdin: str | None = None
    cwd: str | None = None  # working dir for the process; None = throwaway temp dir
    # Optional callback for streaming stdout/stderr chunks during execution.
    # ``stream`` is ``"stdout"`` or ``"stderr"``; ``chunk`` is a decoded text fragment.
    on_output: Callable[[str, str], None] | None = None
    # Resource / isolation knobs (optional; defaults preserve subprocess behaviour).
    env: dict[str, str] | None = None
    # Reserved: NOT honored by GVisorSandbox today — network is always off via the
    # ``--network=none`` runsc flag; "restricted" is a future hook (05 P3-4).
    network_mode: Literal["none", "restricted"] = "none"
    cpu_limit: float = 1.0
    pids_limit: int = 128


@dataclass(frozen=True)
class SandboxCapabilities:
    """Advertised isolation and resource limits of a sandbox backend."""

    isolation: Literal["subprocess", "gvisor", "microvm"]
    supports_network: bool
    max_memory_mb: int
    max_timeout_seconds: int


@dataclass
class ExecutionResult:
    """Result from sandbox code execution."""

    success: bool
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int
    truncated: bool = False

    _MAX_OUTPUT_LEN = 8000

    def __post_init__(self):
        # HEAD+TAIL cut (not head-only): a long stdout's tail — traceback last line /
        # exit summary — must survive this sandbox-level cap, otherwise the downstream
        # ToolResult head+tail (tools/protocol.py) has nothing left to preserve (05 P3-3).
        capped_stdout = truncate_head_tail(self.stdout, self._MAX_OUTPUT_LEN)
        if capped_stdout != self.stdout:
            self.stdout = capped_stdout
            self.truncated = True
        capped_stderr = truncate_head_tail(self.stderr, self._MAX_OUTPUT_LEN)
        if capped_stderr != self.stderr:
            self.stderr = capped_stderr
            self.truncated = True


class SandboxProvider(Protocol):
    """Unified abstraction for code execution sandboxes."""

    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        """Execute code in an isolated environment."""
        ...

    async def health_check(self) -> bool:
        """Check if the sandbox is available."""
        ...

    def capabilities(self) -> SandboxCapabilities:
        """Describe the isolation boundary this provider offers."""
        ...
