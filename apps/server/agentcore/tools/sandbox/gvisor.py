"""GVisor (runsc) based sandbox for secure code execution.

Execution model (安全权限与治理.md §五, as-built):

- **copy-in / copy-out 产物写回**: when the request carries a workspace ``cwd``,
  the workspace is COPIED into a per-run staging dir mounted **rw** at
  ``/workspace`` (cwd), so relative-path writes work like the local sandbox;
  after the process completes, new/changed files are copied back into the real
  workspace under caps and reported via ``ExecutionResult.written_files``.
  Timeout / cancel skip the copy-out (a killed run must not persist
  half-written artifacts).
- **灰度护栏**: a process-global slot limiter caps concurrent executions
  (``GVISOR_MAX_CONCURRENT_EXECUTIONS``), with a bounded grace wait before an
  explainable busy failure; memory/timeout ceilings come from settings.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import sys
import tempfile
import time
import uuid
from collections.abc import Callable
from pathlib import Path

from agentcore.config import settings
from agentcore.core.errors import SandboxError, SandboxTimeoutError
from agentcore.core.logging import get_logger
from agentcore.tools.sandbox.limits import try_acquire_execution_slot
from agentcore.tools.sandbox.protocol import (
    ExecutionRequest,
    ExecutionResult,
    SandboxCapabilities,
)
from agentcore.tools.sandbox.staging import (
    TreeState,
    collect_changes,
    stage_workspace,
    write_back,
)

logger = get_logger(__name__)

_IS_LINUX = sys.platform == "linux"

_LANGUAGE_COMMANDS: dict[str, list[str]] = {
    "python": ["python3", "-u"],
    "javascript": ["node"],
    "bash": ["bash"],
}

_FILE_EXTENSIONS: dict[str, str] = {
    "python": ".py",
    "javascript": ".js",
    "bash": ".sh",
}

_HOST_BIND_PATHS = ("/usr", "/lib", "/lib64", "/bin", "/etc")


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


class GVisorSandbox:
    """SandboxProvider implementation using gVisor runsc."""

    def __init__(
        self,
        *,
        runsc_path: str = "runsc",
        workspace_root: str | None = None,
        runtime_root: str | None = None,
    ) -> None:
        self._runsc = runsc_path
        self._workspace_root = workspace_root
        self._runtime_root = runtime_root or "/tmp/agentcore-sandbox"
        os.makedirs(self._runtime_root, exist_ok=True)

    def capabilities(self) -> SandboxCapabilities:
        return SandboxCapabilities(
            isolation="gvisor",
            supports_network=True,  # restricted mode can enable; default still none
            max_memory_mb=settings.gvisor_memory_limit_mb,
            max_timeout_seconds=settings.gvisor_timeout_max_seconds,
        )

    async def health_check(self) -> bool:
        """Verify runsc is available."""
        if not _IS_LINUX:
            return False
        try:
            proc = await asyncio.create_subprocess_exec(
                self._runsc,
                "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.wait()
            return proc.returncode == 0
        except (FileNotFoundError, OSError):
            return False

    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        """Execute code inside a gVisor sandbox (slot-limited, staged workspace)."""
        if not _IS_LINUX:
            raise SandboxError("GVisor sandbox is only available on Linux")

        if request.language not in _LANGUAGE_COMMANDS:
            return ExecutionResult(
                success=False,
                stdout="",
                stderr=f"Unsupported language: {request.language}",
                exit_code=1,
                duration_ms=0,
            )

        start = time.monotonic()
        # 灰度护栏: bounded wait for a global execution slot, then fail fast with an
        # explainable busy result (never queue past the engine's tool deadline).
        release = await try_acquire_execution_slot()
        if release is None:
            return self._slot_busy_result(start)
        try:
            return await self._execute_in_slot(request, start)
        finally:
            release()

    def _slot_busy_result(self, start: float) -> ExecutionResult:
        capacity = max(1, int(settings.gvisor_max_concurrent_executions))
        waited = float(settings.gvisor_slot_wait_seconds)
        logger.info("sandbox.slot_busy", capacity=capacity, waited_seconds=waited)
        return ExecutionResult(
            success=False,
            stdout="",
            stderr=(
                f"云端执行位已满（并发上限 {capacity}），等待 {waited:g} 秒仍未获得执行位。"
                "请稍后重试；持续繁忙时可拆小任务或错峰执行。"
            ),
            exit_code=-1,
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    def _effective_timeout(self, request: ExecutionRequest) -> int:
        return min(int(request.timeout_seconds), int(settings.gvisor_timeout_max_seconds))

    async def _execute_in_slot(
        self, request: ExecutionRequest, start: float
    ) -> ExecutionResult:
        container_id = f"agentcore-{uuid.uuid4().hex[:12]}"
        bundle_dir = tempfile.mkdtemp(prefix="agentcore_gvisor_")
        process: asyncio.subprocess.Process | None = None
        timeout_seconds = self._effective_timeout(request)

        try:
            scratch_dir = Path(bundle_dir) / "scratch"
            scratch_dir.mkdir()
            rootfs = Path(bundle_dir) / "rootfs"
            rootfs.mkdir()

            ext = _FILE_EXTENSIONS[request.language]
            script_name = f"main{ext}"
            (scratch_dir / script_name).write_text(request.code, encoding="utf-8")
            if request.stdin:
                (scratch_dir / "stdin.txt").write_text(request.stdin, encoding="utf-8")

            # 产物写回 copy-in leg: stage a rw copy of the workspace for the sandbox.
            # No workspace (bare/health-check runs) → old behaviour: scratch doubles
            # as a read-only /workspace and there is nothing to write back to.
            workspace_root = request.cwd or self._workspace_root
            staging_dir: Path | None = None
            staged_state: TreeState | None = None
            if workspace_root:
                staging_dir = Path(bundle_dir) / "workspace"
                staged_state = await asyncio.to_thread(
                    stage_workspace,
                    Path(workspace_root),
                    staging_dir,
                    max_bytes=settings.gvisor_stage_max_bytes,
                )
            workspace = str(staging_dir.resolve()) if staging_dir else str(scratch_dir)
            config = self._build_oci_config(
                request,
                script_name=script_name,
                workspace=workspace,
                scratch_dir=str(scratch_dir.resolve()),
                workspace_writable=staging_dir is not None,
                memory_limit_mb=settings.gvisor_memory_limit_mb,
            )
            (Path(bundle_dir) / "config.json").write_text(
                json.dumps(config),
                encoding="utf-8",
            )

            cmd = [
                self._runsc,
                "run",
                "--rootless",
            ]
            # P2: full_trust → restricted egress; observe/workspace stay offline.
            if request.network_mode != "restricted":
                cmd.append("--network=none")
            cmd.extend(
                [
                    f"--root={self._runtime_root}",
                    f"--bundle={bundle_dir}",
                    container_id,
                ]
            )

            try:
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    stdin=asyncio.subprocess.PIPE if request.stdin else None,
                )
            except OSError as e:
                raise SandboxError(f"代码执行环境启动失败：{e}") from e

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
                    timeout=timeout_seconds,
                )
            except TimeoutError:
                raise SandboxTimeoutError(
                    f"Execution exceeded {timeout_seconds}s timeout"
                ) from None
            finally:
                await asyncio.shield(self._stop_container(container_id, process))

            # Copy-out leg: only a run that COMPLETED (any exit code) persists its
            # artifacts — a partial success (chart saved, later step failed) still
            # delivers files; a timeout-killed run never lands half-written ones.
            written, skipped = await self._write_back_if_staged(
                staging_dir, staged_state, workspace_root
            )

            duration_ms = int((time.monotonic() - start) * 1000)
            return ExecutionResult(
                success=process.returncode == 0,
                stdout=stdout_str,
                stderr=stderr_str,
                exit_code=process.returncode or 0,
                duration_ms=duration_ms,
                written_files=written,
                write_back_skipped=skipped,
            )

        except SandboxTimeoutError:
            duration_ms = int((time.monotonic() - start) * 1000)
            return ExecutionResult(
                success=False,
                stdout="",
                stderr=(
                    f"Timeout: execution exceeded {timeout_seconds}s"
                    "；执行被中断，中断前的文件改动未写回工作区。"
                ),
                exit_code=-1,
                duration_ms=duration_ms,
            )
        finally:
            shutil.rmtree(bundle_dir, ignore_errors=True)

    async def _write_back_if_staged(
        self,
        staging_dir: Path | None,
        staged_state: TreeState | None,
        workspace_root: str | None,
    ) -> tuple[list[str], int]:
        """Copy new/changed staged files back into the real workspace (capped)."""
        if staging_dir is None or staged_state is None or not workspace_root:
            return [], 0

        def _run() -> tuple[list[str], int]:
            changes = collect_changes(staging_dir, staged_state)
            if not changes:
                return [], 0
            report = write_back(
                staging_dir,
                Path(workspace_root),
                changes,
                max_bytes=settings.gvisor_write_back_max_bytes,
                max_files=settings.gvisor_write_back_max_files,
            )
            return report.written, len(report.skipped)

        written, skipped = await asyncio.to_thread(_run)
        if written or skipped:
            logger.info(
                "sandbox.write_back",
                written=len(written),
                skipped=skipped,
                files=written[:20],
            )
        return written, skipped

    def _build_command(self, request: ExecutionRequest, script_path: str) -> list[str]:
        if request.stdin and request.language == "bash":
            return ["bash", "-c", f"{script_path} < /scratch/stdin.txt"]
        return _LANGUAGE_COMMANDS[request.language] + [script_path]

    def _build_env(self, request: ExecutionRequest) -> list[str]:
        env: dict[str, str] = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": "/tmp",
            "LANG": "C.UTF-8",
            "GIT_TERMINAL_PROMPT": "0",
            "PYTHONDONTWRITEBYTECODE": "1",
            # Headless plotting: the sandbox has no display; without an explicit
            # backend matplotlib may probe for GUI toolkits and fail confusingly.
            "MPLBACKEND": "Agg",
        }
        if request.env:
            env.update(request.env)
        return [f"{key}={value}" for key, value in env.items()]

    def _host_bind_mounts(self) -> list[dict]:
        mounts: list[dict] = []
        for path in _HOST_BIND_PATHS:
            if os.path.isdir(path):
                mounts.append(
                    {
                        "destination": path,
                        "type": "bind",
                        "source": path,
                        "options": ["ro", "rbind", "nosuid"],
                    }
                )
        return mounts

    def _build_oci_config(
        self,
        request: ExecutionRequest,
        *,
        script_name: str,
        workspace: str,
        scratch_dir: str,
        workspace_writable: bool = False,
        memory_limit_mb: int | None = None,
    ) -> dict:
        script_path = f"/scratch/{script_name}"
        namespaces = [
            {"type": "pid"},
            {"type": "ipc"},
            {"type": "uts"},
            {"type": "mount"},
        ]
        # P2: restricted mode adds a network namespace so the process can reach
        # the public internet (runsc without ``--network=none``). observe /
        # workspace keep the offline posture (no network ns + ``--network=none``).
        # Application-level SSRF for product HTTP tools remains ``core/net.py``;
        # in-sandbox raw sockets are OS-egress only (no private-IP filter inside
        # runsc — multi-tenant hardening is still gVisor's isolation boundary).
        if request.network_mode == "restricted":
            namespaces.append({"type": "network"})

        mounts = [
            {
                "destination": "/tmp",
                "type": "tmpfs",
                "source": "tmpfs",
                "options": ["nosuid", "nodev", "size=64m"],
            },
            # 产物写回 (安全权限与治理 §5): /workspace is normally a per-run rw STAGING
            # COPY of the real workspace (cwd here), so relative-path writes behave like
            # the local SubprocessSandbox; the canonical workspace stays out of the
            # sandbox's reach and changed files are copied back post-run under caps.
            # ``workspace_writable=False`` is the legacy bare/no-workspace posture
            # (read-only bind, nothing to write back to).
            {
                "destination": "/workspace",
                "type": "bind",
                "source": workspace,
                "options": (
                    ["rw", "rbind", "nosuid", "nodev"]
                    if workspace_writable
                    else ["ro", "rbind"]
                ),
            },
            {
                "destination": "/scratch",
                "type": "bind",
                "source": scratch_dir,
                "options": ["rw", "rbind", "nosuid", "nodev"],
            },
            *self._host_bind_mounts(),
        ]

        return {
            "ociVersion": "1.0.2",
            "process": {
                "terminal": False,
                "user": {"uid": 65534, "gid": 65534},
                "args": self._build_command(request, script_path),
                "env": self._build_env(request),
                "cwd": "/workspace",
            },
            "root": {"path": "rootfs", "readonly": True},
            "mounts": mounts,
            "linux": {
                "resources": {
                    # Cloud runs take the configured guardrail ceiling; the request's
                    # own field only applies when no explicit limit is passed (bare
                    # sandbox use in tests).
                    "memory": {
                        "limit": (memory_limit_mb or request.memory_limit_mb) * 1024 * 1024
                    },
                    "cpu": {
                        "quota": int(request.cpu_limit * 100000),
                        "period": 100000,
                    },
                    "pids": {"limit": request.pids_limit},
                },
                "namespaces": namespaces,
            },
        }

    async def _runsc_cmd(self, *args: str) -> None:
        with contextlib.suppress(Exception):
            proc = await asyncio.create_subprocess_exec(
                self._runsc,
                *args,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()

    async def _stop_container(
        self,
        container_id: str,
        process: asyncio.subprocess.Process | None,
    ) -> None:
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            with contextlib.suppress(Exception):
                await process.wait()
        await self._runsc_cmd("kill", container_id, "SIGKILL")
        await self._runsc_cmd("delete", container_id)
