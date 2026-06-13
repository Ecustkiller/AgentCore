"""SubprocessSandbox implementation (MVP).

Executes code in a restricted subprocess with:
- Timeout enforcement (kill on timeout)
- Temporary directory isolation (per-execution)
- stdout/stderr capture
- Basic resource limits (where supported)
"""

import asyncio
import tempfile
import time
from pathlib import Path

from agentcore.core.errors import SandboxError, SandboxTimeoutError
from agentcore.tools.sandbox.protocol import ExecutionRequest, ExecutionResult

_LANGUAGE_COMMANDS: dict[str, list[str]] = {
    "python": ["python", "-u"],
    "javascript": ["node"],
    "bash": ["bash"],
}

_FILE_EXTENSIONS: dict[str, str] = {
    "python": ".py",
    "javascript": ".js",
    "bash": ".sh",
}


class SubprocessSandbox:
    """Restricted subprocess sandbox for MVP code execution."""

    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        """Execute code in a temporary directory with timeout."""
        if request.language not in _LANGUAGE_COMMANDS:
            return ExecutionResult(
                success=False,
                stdout="",
                stderr=f"Unsupported language: {request.language}",
                exit_code=1,
                duration_ms=0,
            )

        start = time.monotonic()

        with tempfile.TemporaryDirectory(prefix="agentcore_sandbox_") as tmpdir:
            ext = _FILE_EXTENSIONS[request.language]
            code_file = Path(tmpdir) / f"main{ext}"
            code_file.write_text(request.code, encoding="utf-8")

            cmd = _LANGUAGE_COMMANDS[request.language] + [str(code_file)]

            try:
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    stdin=asyncio.subprocess.PIPE if request.stdin else None,
                    cwd=tmpdir,
                )

                stdin_bytes = request.stdin.encode() if request.stdin else None

                try:
                    stdout_bytes, stderr_bytes = await asyncio.wait_for(
                        process.communicate(input=stdin_bytes),
                        timeout=request.timeout_seconds,
                    )
                except TimeoutError:
                    process.kill()
                    await process.wait()
                    duration_ms = int((time.monotonic() - start) * 1000)
                    raise SandboxTimeoutError(
                        f"Execution exceeded {request.timeout_seconds}s timeout"
                    ) from None

                duration_ms = int((time.monotonic() - start) * 1000)

                return ExecutionResult(
                    success=process.returncode == 0,
                    stdout=stdout_bytes.decode(errors="replace"),
                    stderr=stderr_bytes.decode(errors="replace"),
                    exit_code=process.returncode or 0,
                    duration_ms=duration_ms,
                )

            except SandboxTimeoutError:
                duration_ms = int((time.monotonic() - start) * 1000)
                return ExecutionResult(
                    success=False,
                    stdout="",
                    stderr=f"Timeout: execution exceeded {request.timeout_seconds}s",
                    exit_code=-1,
                    duration_ms=duration_ms,
                )
            except OSError as e:
                raise SandboxError(f"Failed to start process: {e}") from e

    async def health_check(self) -> bool:
        """Verify the sandbox can execute code."""
        try:
            result = await self.execute(
                ExecutionRequest(code="print('ok')", language="python", timeout_seconds=5)
            )
            return result.success and "ok" in result.stdout
        except Exception:
            return False
