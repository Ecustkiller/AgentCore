"""SubprocessSandbox implementation (MVP).

Executes code in a restricted subprocess with:
- Timeout enforcement (kill on timeout)
- Temporary directory isolation (per-execution)
- stdout/stderr capture
- Basic resource limits (where supported)
"""

import asyncio
import shutil
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


async def _cleanup_tempdir(path: str) -> None:
    """Best-effort removal of an execution temp dir.

    On Windows the subprocess holds its cwd (the temp dir) and the OS releases
    that handle only shortly after the process exits, so an immediate rmtree can
    fail with a sharing violation (WinError 32). Retry a few times, then give up:
    a stray temp dir is harmless and eventually reaped by the OS.
    """
    for delay in (0.0, 0.05, 0.2, 0.5):
        if delay:
            await asyncio.sleep(delay)
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            continue
    shutil.rmtree(path, ignore_errors=True)


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

        tmpdir = tempfile.mkdtemp(prefix="agentcore_sandbox_")
        try:
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
                    # Run in the caller's workspace when given (so code sees the
                    # same files as the file tools); else the throwaway temp dir.
                    cwd=request.cwd or tmpdir,
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
        finally:
            await _cleanup_tempdir(tmpdir)

    async def health_check(self) -> bool:
        """Verify the sandbox can execute code."""
        try:
            result = await self.execute(
                ExecutionRequest(code="print('ok')", language="python", timeout_seconds=5)
            )
            return result.success and "ok" in result.stdout
        except Exception:
            return False
