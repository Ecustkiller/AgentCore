"""SubprocessSandbox — run code in a child process (MVP; NOT an isolation boundary).

What it actually provides:
- Timeout enforcement (kill the whole process tree on timeout / cancel)
- A per-execution temp dir used as the default working directory
- stdout/stderr capture

What it does NOT provide — read before enabling on a shared/cloud host:
- NO real isolation: the child runs with the **full privileges of the API process**
  (filesystem read/write, free network egress, and access to in-process secrets such as
  JWT_SECRET_KEY / ENCRYPTION_KEY and every user's encrypted keys).
- NO namespace / seccomp / cgroup / rlimit / egress controls of any kind.

So it is safe ONLY where the caller already trusts the code: local/sidecar mode
(``location=local`` — the user's own machine). On a cloud/server worker it is gated off
by default and guarded at startup (see ``code_execute_cloud_enabled`` /
``code_execute_cloud_unsafe_ack`` and ``main._validate_production_security``); a true
sandbox (container/gVisor/nsjail/firecracker) is required before exposing it to
untrusted input (SEC-005).
"""

import asyncio
import contextlib
import os
import shutil
import signal
import sys
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

from agentcore.core.errors import SandboxError, SandboxTimeoutError
from agentcore.tools.sandbox.protocol import (
    ExecutionRequest,
    ExecutionResult,
    SandboxCapabilities,
)

_IS_WINDOWS = sys.platform == "win32"

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


def _new_group_kwargs() -> dict:
    """Spawn kwargs that make the child the head of its own killable group.

    Killing only the direct child (``process.kill()``) leaves any helper it spawned
    running as an orphan — and on Windows an orphan keeps its inherited cwd (the
    workspace / temp dir) locked in "delete-pending" limbo, so that directory can
    never be removed until the stray handle closes. POSIX: ``start_new_session`` makes
    the child a process-group leader so cleanup can ``killpg`` the whole group. Windows
    needs no flag — ``taskkill /T`` walks the live parent→child tree by pid.
    """
    return {} if _IS_WINDOWS else {"start_new_session": True}


async def _reap_tree(process: asyncio.subprocess.Process, pid: int) -> None:
    """Kill the child AND every descendant it spawned, then reap the child.

    Only fires while the child is still alive (``returncode is None``) — its own
    timeout, an external cancel, or a hang — so the pid is unambiguously ours and not
    yet recycled (no risk of signalling an unrelated process). A child that already
    exited cleanly is left alone. Best-effort throughout: never raises.
    """
    if process.returncode is not None:
        return
    if _IS_WINDOWS:
        # /T = whole descendant tree, /F = force; run while the parent pid is still
        # live so the tree is intact (it reparents nothing on Windows once dead).
        with contextlib.suppress(Exception):
            killer = await asyncio.create_subprocess_exec(
                "taskkill",
                "/F",
                "/T",
                "/PID",
                str(pid),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
    else:
        # SIGKILL the child's whole process group (pgid == leader pid).
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(pid, signal.SIGKILL)
    with contextlib.suppress(Exception):
        await process.wait()


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


async def _read_stream(
    stream: asyncio.StreamReader | None,
    stream_name: str,
    buffer: list[str],
    on_output: Callable[[str, str], None] | None,
) -> None:
    """Read from a subprocess stream in chunks, optionally forwarding each chunk."""
    if stream is None:
        return
    while True:
        chunk = await stream.read(2048)
        if not chunk:
            break
        text = chunk.decode("utf-8", errors="replace")
        buffer.append(text)
        if on_output:
            on_output(stream_name, text)


class SubprocessSandbox:
    """Restricted subprocess sandbox for MVP code execution."""

    def capabilities(self) -> SandboxCapabilities:
        return SandboxCapabilities(
            isolation="subprocess",
            supports_network=True,
            max_memory_mb=512,
            max_timeout_seconds=90,
        )

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
                    **_new_group_kwargs(),
                )
                # Capture the pid up front: after a clean exit asyncio reaps the child
                # and its pid can be recycled, so the cleanup keys off this snapshot.
                child_pid = process.pid

                stdin_bytes = request.stdin.encode() if request.stdin else None

                try:

                    async def _collect_output() -> tuple[str, str]:
                        if stdin_bytes is not None and process.stdin is not None:
                            process.stdin.write(stdin_bytes)
                            await process.stdin.drain()
                            process.stdin.close()

                        stdout_buf: list[str] = []
                        stderr_buf: list[str] = []
                        await asyncio.gather(
                            _read_stream(
                                process.stdout,
                                "stdout",
                                stdout_buf,
                                request.on_output,
                            ),
                            _read_stream(
                                process.stderr,
                                "stderr",
                                stderr_buf,
                                request.on_output,
                            ),
                        )
                        await process.wait()
                        return "".join(stdout_buf), "".join(stderr_buf)

                    stdout_str, stderr_str = await asyncio.wait_for(
                        _collect_output(),
                        timeout=request.timeout_seconds,
                    )
                except TimeoutError:
                    duration_ms = int((time.monotonic() - start) * 1000)
                    raise SandboxTimeoutError(
                        f"Execution exceeded {request.timeout_seconds}s timeout"
                    ) from None
                finally:
                    # Reap the child's WHOLE tree on ANY non-normal exit — its own
                    # timeout OR an external cancel (the engine's tool-timeout backstop
                    # or a user stop propagating CancelledError) — so neither the child
                    # nor any helper it spawned outlives the call as an orphan holding
                    # the workspace open (B1 取消安全). ``shield`` keeps a cancel from
                    # abandoning the reap mid-flight; a clean completion is a no-op.
                    await asyncio.shield(_reap_tree(process, child_pid))

                duration_ms = int((time.monotonic() - start) * 1000)

                return ExecutionResult(
                    success=process.returncode == 0,
                    stdout=stdout_str,
                    stderr=stderr_str,
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
                raise SandboxError(f"代码执行环境启动失败：{e}") from e
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
