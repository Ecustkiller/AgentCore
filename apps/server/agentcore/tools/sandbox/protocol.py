"""SandboxProvider Protocol for isolated code execution."""

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
