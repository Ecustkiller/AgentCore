"""Loop-agnostic child processes for the API / sidecar.

uvicorn ``--reload`` (and ``workers > 1``) on Windows installs a
``SelectorEventLoop``. That loop's ``asyncio.create_subprocess_exec`` raises
``NotImplementedError``. Blocking ``subprocess.Popen`` in a worker thread still
runs, and the event loop only waits — so ``wait_for`` / cancellation stay able
to kill the child.

POSIX children start a new session so a timeout can ``killpg`` the tree.
Windows uses ``taskkill /T``. stdin is always ``DEVNULL`` (a sidecar's stdin is
the JSON-RPC pipe; inheriting it stalls git until the tool timeout).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import subprocess
import sys
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SpawnedProcess:
    """One finished child. ``lines`` is set only for the stdout line cap."""

    returncode: int
    stdout: bytes = b""
    stderr: bytes = b""
    lines: tuple[str, ...] = ()
    truncated: bool = False


def _start_new_session() -> bool:
    # Windows rejects start_new_session=True. False matches the default.
    return sys.platform != "win32"


def kill_process_tree(proc: subprocess.Popen[bytes]) -> None:
    """Signal the child and descendants. Does not ``wait`` — the owner thread does.

    ``Popen.wait`` / ``communicate`` must not run on two threads at once.
    """
    if proc.poll() is not None:
        return
    pid = proc.pid
    if sys.platform == "win32":
        with contextlib.suppress(Exception):
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
    else:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(pid, signal.SIGKILL)
        with contextlib.suppress(ProcessLookupError):
            proc.kill()


def _reap_owner(proc: subprocess.Popen[bytes]) -> None:
    """Kill, then wait. Only the thread already blocked in ``communicate`` / read."""
    kill_process_tree(proc)
    with contextlib.suppress(Exception):
        proc.wait(timeout=5)


def _kill_holder(
    lock: threading.Lock,
    holder: dict[str, subprocess.Popen[bytes]],
) -> None:
    with lock:
        proc = holder.get("proc")
    if proc is not None:
        kill_process_tree(proc)


def _read_capped(
    proc: subprocess.Popen[bytes],
    stop: threading.Event,
    max_lines: int,
) -> SpawnedProcess:
    """Keep at most ``max_lines`` non-empty stdout lines, then kill."""
    lines: list[str] = []
    truncated = False
    stderr_chunks: list[bytes] = []

    def _drain_stderr() -> None:
        stream = proc.stderr
        if stream is None:
            return
        with contextlib.suppress(Exception):
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    return
                stderr_chunks.append(chunk)

    drain = threading.Thread(target=_drain_stderr, name="spawn-stderr")
    drain.start()
    try:
        stream = proc.stdout
        if stream is not None:
            while True:
                if stop.is_set():
                    _reap_owner(proc)
                    break
                raw = stream.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line:
                    continue
                lines.append(line)
                if len(lines) > max_lines:
                    truncated = True
                    lines = lines[:max_lines]
                    _reap_owner(proc)
                    break
        if proc.poll() is None:
            proc.wait()
    finally:
        drain.join(timeout=5)
    code = proc.returncode if proc.returncode is not None else -1
    stderr = b"".join(stderr_chunks)
    return SpawnedProcess(
        returncode=code,
        stderr=stderr,
        lines=tuple(lines),
        truncated=truncated,
    )


def _execute(
    argv: Sequence[str],
    *,
    cwd: str | Path | None,
    env: Mapping[str, str] | None,
    stop: threading.Event,
    lock: threading.Lock,
    holder: dict[str, subprocess.Popen[bytes]],
    max_stdout_lines: int | None,
) -> SpawnedProcess:
    proc = subprocess.Popen(
        list(argv),
        cwd=None if cwd is None else str(cwd),
        env=None if env is None else dict(env),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=_start_new_session(),
    )
    with lock:
        holder["proc"] = proc
        cancelled = stop.is_set()
    if cancelled:
        _reap_owner(proc)
        code = proc.returncode if proc.returncode is not None else -1
        return SpawnedProcess(returncode=code)
    if max_stdout_lines is not None:
        return _read_capped(proc, stop, max_stdout_lines)
    stdout, stderr = proc.communicate()
    if stop.is_set():
        _reap_owner(proc)
    code = proc.returncode if proc.returncode is not None else -1
    return SpawnedProcess(
        returncode=code,
        stdout=stdout or b"",
        stderr=stderr or b"",
    )


async def spawn_process(
    argv: Sequence[str],
    *,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    timeout: float | None = None,
    max_stdout_lines: int | None = None,
) -> SpawnedProcess:
    """Run ``argv`` off the event loop. Timeout and cancellation kill the tree.

    ``max_stdout_lines`` keeps that many non-empty stdout lines, then stops the
    child (``rg`` hit / file cap). ``FileNotFoundError`` propagates when the
    binary is missing.
    """
    stop = threading.Event()
    lock = threading.Lock()
    holder: dict[str, subprocess.Popen[bytes]] = {}

    def _run() -> SpawnedProcess:
        return _execute(
            argv,
            cwd=cwd,
            env=env,
            stop=stop,
            lock=lock,
            holder=holder,
            max_stdout_lines=max_stdout_lines,
        )

    work = asyncio.create_task(asyncio.to_thread(_run))
    try:
        if timeout is None:
            return await work
        done, _pending = await asyncio.wait({work}, timeout=timeout)
        if work in done:
            return work.result()
        stop.set()
        await asyncio.to_thread(_kill_holder, lock, holder)
        with contextlib.suppress(Exception):
            await work
        raise TimeoutError
    except asyncio.CancelledError:
        stop.set()
        await asyncio.shield(asyncio.to_thread(_kill_holder, lock, holder))
        with contextlib.suppress(Exception):
            await asyncio.shield(work)
        raise
