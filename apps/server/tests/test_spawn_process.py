"""Child processes must run under a Windows SelectorEventLoop.

uvicorn ``--reload`` installs that loop, and ``asyncio.create_subprocess_exec``
raises ``NotImplementedError`` there. ``spawn_process`` uses a worker-thread
``Popen`` so rg / git in the API process still start, and cancellation still
kills the child.
"""

from __future__ import annotations

import asyncio
import sys
import time

import pytest

from agentcore.core.spawn import spawn_process


def _selector_loop() -> asyncio.AbstractEventLoop:
    return asyncio.SelectorEventLoop()


def _python_sleep(seconds: float) -> list[str]:
    return [sys.executable, "-c", f"import time; time.sleep({seconds})"]


def test_spawn_succeeds_under_selector_event_loop() -> None:
    async def _run() -> None:
        result = await spawn_process(
            [sys.executable, "-c", "print('selector-ok')"],
        )
        assert result.returncode == 0
        assert b"selector-ok" in result.stdout

    loop = _selector_loop()
    try:
        loop.run_until_complete(_run())
    finally:
        loop.close()


def test_stdin_is_devnull_under_selector_event_loop() -> None:
    async def _run() -> None:
        result = await spawn_process(
            [sys.executable, "-c", "import sys; print(len(sys.stdin.read()))"],
        )
        assert result.returncode == 0
        assert result.stdout.strip() == b"0"

    loop = _selector_loop()
    try:
        loop.run_until_complete(_run())
    finally:
        loop.close()


def test_cancel_kills_child_under_selector_event_loop() -> None:
    async def _run() -> None:
        started = time.monotonic()
        task = asyncio.create_task(spawn_process(_python_sleep(30)))
        await asyncio.sleep(0.2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert time.monotonic() - started < 5

    loop = _selector_loop()
    try:
        loop.run_until_complete(_run())
    finally:
        loop.close()


def test_timeout_kills_child_under_selector_event_loop() -> None:
    async def _run() -> None:
        ticks = 0

        async def ticker() -> None:
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0.05)

        task = asyncio.create_task(ticker())
        started = time.monotonic()
        try:
            with pytest.raises(TimeoutError):
                await spawn_process(_python_sleep(30), timeout=0.4)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert time.monotonic() - started < 5
        assert ticks >= 2

    loop = _selector_loop()
    try:
        loop.run_until_complete(_run())
    finally:
        loop.close()


def test_stdout_line_cap_kills_child_under_selector_event_loop() -> None:
    script = (
        "import time\n"
        "for i in range(40):\n"
        "    print(i, flush=True)\n"
        "    time.sleep(0.05)\n"
    )

    async def _run() -> None:
        started = time.monotonic()
        result = await spawn_process(
            [sys.executable, "-c", script],
            max_stdout_lines=3,
        )
        assert time.monotonic() - started < 3
        assert result.truncated is True
        assert result.lines == ("0", "1", "2")

    loop = _selector_loop()
    try:
        loop.run_until_complete(_run())
    finally:
        loop.close()


def test_missing_binary_raises_under_selector_event_loop() -> None:
    async def _run() -> None:
        with pytest.raises(FileNotFoundError):
            await spawn_process(["agentcore-no-such-binary-xyz"])

    loop = _selector_loop()
    try:
        loop.run_until_complete(_run())
    finally:
        loop.close()
