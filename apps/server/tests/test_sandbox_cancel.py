"""SubprocessSandbox cancel-safety (B1 取消安全).

A ``code_execute`` call aborted mid-flight — by the engine's tool-timeout backstop
or a user stop propagating ``CancelledError`` into the await — must not leave the
child process running as an orphan. We prove it with a sentinel: code that sleeps
THEN writes a file, so the file appears only if the process survived the cancel and
ran to completion. A working kill means it never appears.
"""

import asyncio
import contextlib
from pathlib import Path

from agentcore.tools.sandbox.protocol import ExecutionRequest
from agentcore.tools.sandbox.subprocess import SubprocessSandbox


async def test_cancel_kills_subprocess_no_orphan(tmp_path: Path):
    sentinel = tmp_path / "ran.txt"
    code = (
        "import time, pathlib\n"
        "time.sleep(1.0)\n"
        f"pathlib.Path('{sentinel.as_posix()}').write_text('done')\n"
    )
    sandbox = SubprocessSandbox()
    request = ExecutionRequest(code=code, language="python", timeout_seconds=30)

    task = asyncio.create_task(sandbox.execute(request))
    await asyncio.sleep(0.3)  # let the subprocess actually start
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task

    # Wait past when the sentinel would have been written had the child survived the
    # cancel; a correctly-killed process never gets there.
    await asyncio.sleep(1.2)
    assert not sentinel.exists()


async def test_timeout_kills_subprocess_no_orphan(tmp_path: Path):
    # The same guarantee on the tool's own timeout path: the sandbox's wait_for fires
    # at 1s, the child (sleeping 3s) is killed, and a graceful timeout result returns.
    sentinel = tmp_path / "ran.txt"
    code = (
        "import time, pathlib\n"
        "time.sleep(3.0)\n"
        f"pathlib.Path('{sentinel.as_posix()}').write_text('done')\n"
    )
    sandbox = SubprocessSandbox()
    request = ExecutionRequest(code=code, language="python", timeout_seconds=1)

    result = await sandbox.execute(request)
    assert result.success is False  # graceful SandboxTimeout result (exit_code -1)

    # Past the child's 3s write point (≈1s already elapsed in execute); a killed
    # process never writes the sentinel.
    await asyncio.sleep(2.5)
    assert not sentinel.exists()
