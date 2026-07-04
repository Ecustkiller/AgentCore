"""SandboxProvider Protocol for isolated code execution."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, Protocol


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
        if len(self.stdout) > self._MAX_OUTPUT_LEN:
            self.stdout = self.stdout[: self._MAX_OUTPUT_LEN] + "\n... [truncated]"
            self.truncated = True
        if len(self.stderr) > self._MAX_OUTPUT_LEN:
            self.stderr = self.stderr[: self._MAX_OUTPUT_LEN] + "\n... [truncated]"
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
