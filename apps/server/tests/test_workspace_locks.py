"""Tests for the folder-level workspace lock (决策④ / A′).

Verifies that the same workspace key serializes writes (one mutation at a time,
others queue) while different keys run concurrently. Also guards honest wait
UX: contended acquires notify ``on_waiting``; uncontended stays silent
（不得静默等锁）. A′: whole-turn holders gone; write/snapshot sinks hold the key.
"""

from __future__ import annotations

import asyncio
import inspect
from pathlib import Path

import pytest

from agentcore.tools.sandbox import SubprocessSandbox
from agentcore.workspace.locks import workspace_lock
from agentcore.workspace.server import ServerWorkspace


async def test_same_key_serializes():
    events: list[str] = []

    async def worker(name: str) -> None:
        async with workspace_lock("ws/u1/f1"):
            events.append(f"{name}-enter")
            await asyncio.sleep(0.02)
            events.append(f"{name}-exit")

    await asyncio.gather(worker("A"), worker("B"))

    # Each enter is immediately followed by its own exit — no interleaving.
    assert events in (
        ["A-enter", "A-exit", "B-enter", "B-exit"],
        ["B-enter", "B-exit", "A-enter", "A-exit"],
    )


async def test_different_keys_run_concurrently():
    events: list[str] = []

    async def worker(key: str, name: str) -> None:
        async with workspace_lock(key):
            events.append(f"{name}-enter")
            await asyncio.sleep(0.02)
            events.append(f"{name}-exit")

    await asyncio.gather(worker("ws/u1/f1", "A"), worker("ws/u1/f2", "B"))

    # Both enter before either exits → they overlapped (no mutual exclusion).
    assert set(events[:2]) == {"A-enter", "B-enter"}


async def test_lock_released_after_block():
    key = "ws/u1/f1"
    async with workspace_lock(key):
        pass
    # Re-acquiring immediately must not block (the previous block released it).
    await asyncio.wait_for(_acquire_once(key), timeout=1.0)


async def test_on_waiting_silent_when_uncontended():
    """不得静默等锁：无争用不回调——客户端不得靠假排队 UI。"""
    calls: list[bool] = []
    async with workspace_lock("ws/u1/silent", on_waiting=calls.append):
        pass
    assert calls == []


async def test_on_waiting_emitted_when_contended():
    """Contended acquire: waiting=True before block, False after acquire."""
    key = "ws/u1/wait"
    calls: list[bool] = []
    gate = asyncio.Event()

    async def holder() -> None:
        async with workspace_lock(key):
            gate.set()
            await asyncio.sleep(0.05)

    async def waiter() -> None:
        await gate.wait()
        async with workspace_lock(key, on_waiting=calls.append):
            pass

    await asyncio.gather(holder(), waiter())
    assert calls == [True, False]


async def test_stream_chat_does_not_hold_whole_turn_lock():
    """A′: kickoff must not wrap prepare/LLM in workspace_lock（不得静默等锁）."""
    from agentcore.conversation import turns

    src = inspect.getsource(turns.stream_chat)
    assert "async with workspace_lock" not in src
    assert "不得静默等锁" in src or "no whole-turn workspace_lock" in src


async def test_regenerate_and_resume_do_not_hold_whole_turn_lock():
    from agentcore.conversation import turns

    for fn in (turns.regenerate_chat, turns.resume_chat):
        src = inspect.getsource(fn)
        assert "async with workspace_lock" not in src, fn.__name__


async def test_same_folder_turns_can_overlap_without_write():
    """A′: two same-key coroutines without taking the lock overlap (prepare/LLM path)."""
    events: list[str] = []

    async def pretend_turn(name: str) -> None:
        events.append(f"{name}-prepare")
        await asyncio.sleep(0.02)
        events.append(f"{name}-token")

    await asyncio.gather(pretend_turn("A"), pretend_turn("B"))
    assert set(events[:2]) == {"A-prepare", "B-prepare"}


async def test_concurrent_server_writes_serialize(tmp_path: Path):
    """Same lock_key: two writes must not overlap under ``_mutation_lock``."""
    from contextlib import asynccontextmanager

    key = f"ws/test/{tmp_path.name}"
    backend = ServerWorkspace(root=tmp_path, sandbox=SubprocessSandbox(), lock_key=key)
    events: list[str] = []
    real_lock = backend._mutation_lock

    @asynccontextmanager
    async def holding_lock(path: str):
        async with real_lock(path):
            events.append("enter")
            await asyncio.sleep(0.03)
            try:
                yield
            finally:
                events.append("exit")

    backend._mutation_lock = holding_lock  # type: ignore[method-assign]
    await asyncio.gather(backend.write("a.txt", "A"), backend.write("b.txt", "B"))
    assert events == ["enter", "exit", "enter", "exit"]
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "A"
    assert (tmp_path / "b.txt").read_text(encoding="utf-8") == "B"


async def test_execute_holds_mutation_lock_against_write(tmp_path: Path):
    """A′ P0: execute must serialize with file writes on the same lock_key."""
    from agentcore.tools.sandbox.protocol import ExecutionRequest, ExecutionResult

    key = f"ws/test/exec-{tmp_path.name}"
    backend = ServerWorkspace(root=tmp_path, sandbox=SubprocessSandbox(), lock_key=key)
    order: list[str] = []

    class SlowSandbox:
        async def health_check(self) -> bool:
            # ServerWorkspace probes once via health_check before execute.
            return True

        async def execute(self, req: ExecutionRequest) -> ExecutionResult:
            order.append("exec-enter")
            await asyncio.sleep(0.05)
            order.append("exec-exit")
            return ExecutionResult(
                success=True, stdout="", stderr="", exit_code=0, duration_ms=50
            )

    backend._sandbox = SlowSandbox()  # type: ignore[assignment]

    async def do_exec() -> None:
        await backend.execute(
            ExecutionRequest(language="python", code="print(1)", timeout_seconds=5)
        )

    async def do_write() -> None:
        await asyncio.sleep(0.01)  # let execute acquire first
        order.append("write-start")
        await backend.write("x.txt", "X")
        order.append("write-done")

    await asyncio.gather(do_exec(), do_write())
    # write body must not finish between exec-enter and exec-exit
    assert order.index("write-done") >= order.index("exec-exit")
    assert order.index("exec-enter") < order.index("exec-exit")
    assert (tmp_path / "x.txt").read_text(encoding="utf-8") == "X"


async def test_on_waiting_cleared_when_acquire_cancelled():
    """Cancel while blocked on acquire must still fire on_waiting(False)."""
    key = "ws/u1/cancel-wait"
    flags: list[bool] = []

    async def holder() -> None:
        async with workspace_lock(key):
            await asyncio.sleep(0.5)

    async def waiter() -> None:
        async with workspace_lock(key, on_waiting=flags.append):
            pass

    h = asyncio.create_task(holder())
    await asyncio.sleep(0.01)
    w = asyncio.create_task(waiter())
    await asyncio.sleep(0.01)
    assert flags == [True]
    w.cancel()
    with pytest.raises(asyncio.CancelledError):
        await w
    assert flags == [True, False]
    h.cancel()
    with pytest.raises(asyncio.CancelledError):
        await h


async def test_concurrent_create_snapshot_manifest_keeps_both(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from agentcore.storage.filesystem import FilesystemStorageProvider
    from agentcore.workspace import snapshots as snap_mod

    snap_root = tmp_path / "snapshots"
    snap_root.mkdir()
    provider = FilesystemStorageProvider(base_dir=snap_root)
    monkeypatch.setattr(snap_mod, "build_storage_provider", lambda: provider)

    def _resolve(*, user_id: str, folder_id: str | None, conversation_id: str) -> Path:
        root = tmp_path / "ws" / user_id / (folder_id or "x") / conversation_id
        root.mkdir(parents=True, exist_ok=True)
        (root / "f.txt").write_text("x", encoding="utf-8")
        return root

    monkeypatch.setattr(snap_mod, "resolve_workspace_root", _resolve)
    monkeypatch.setattr(
        snap_mod,
        "workspace_storage_key",
        lambda *, user_id, folder_id, conversation_id: f"workspaces/{user_id}/{folder_id}",
    )
    monkeypatch.setattr(snap_mod.settings, "workspace_auto_snapshot_max", 10)

    async def one(label: str):
        return await snap_mod.create_snapshot(
            user_id="u1",
            folder_id="f1",
            conversation_id=f"c-{label}",
            label=label,
        )

    refs = await asyncio.gather(one("a"), one("b"))
    listed = await snap_mod.list_snapshots(
        user_id="u1", folder_id="f1", conversation_id="c-a"
    )
    ids = {r.snapshot_id for r in refs}
    listed_ids = {s.snapshot_id for s in listed}
    assert ids <= listed_ids
    assert len(listed_ids) >= 2


async def test_nested_same_key_deadlocks():
    """asyncio.Lock is not reentrant — nested same-key acquire must time out."""
    key = "ws/u1/nest"

    async def nested() -> None:
        async with workspace_lock(key), workspace_lock(key):
            pass

    with pytest.raises(TimeoutError):
        await asyncio.wait_for(nested(), timeout=0.2)


async def _acquire_once(key: str) -> None:
    async with workspace_lock(key):
        return
