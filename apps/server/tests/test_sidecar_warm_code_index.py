"""Sidecar warmCodeIndex RPC + initialize schedule (non-turn index warm)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

from agentcore.sidecar.protocol import NOT_INITIALIZED
from agentcore.sidecar.server import SidecarServer
from agentcore.workspace.indexing.registry import clear_index_registry


def _recorder() -> tuple[list[dict[str, Any]], Any]:
    sent: list[dict[str, Any]] = []

    async def write_line(line: str) -> None:
        sent.append(json.loads(line))

    return sent, write_line


def test_warm_code_index_requires_initialize(tmp_path: Path) -> None:
    clear_index_registry()
    sent, write_line = _recorder()
    server = SidecarServer(write_line)

    async def run() -> None:
        await server.handle_line(
            json.dumps(
                {"jsonrpc": "2.0", "id": 2, "method": "warmCodeIndex", "params": {}}
            )
        )

    asyncio.run(run())
    err = next(m for m in sent if m.get("id") == 2 and "error" in m)
    assert err["error"]["code"] == NOT_INITIALIZED


def test_warm_code_index_schedules_without_awaiting_ensure(
    tmp_path: Path, monkeypatch
) -> None:
    clear_index_registry()
    (tmp_path / "hello.py").write_text("print(1)\n", encoding="utf-8")
    sent, write_line = _recorder()
    server = SidecarServer(write_line)

    scheduled: list[str] = []

    def fake_start(self: Any) -> None:  # noqa: ANN401
        scheduled.append(str(self._root))

    monkeypatch.setattr(
        "agentcore.workspace.server.ServerWorkspace.start_code_index_maintenance",
        fake_start,
    )

    async def run() -> None:
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "userId": "u",
                        "workspaceRoot": str(tmp_path),
                        "approvalsEnabled": True,
                    },
                }
            )
        )
        await server.handle_line(
            json.dumps(
                {"jsonrpc": "2.0", "id": 2, "method": "warmCodeIndex", "params": {}}
            )
        )

    asyncio.run(run())

    # initialize + warmCodeIndex each schedule once (coalesce is maintainer-side).
    assert len(scheduled) == 2
    ok = next(m for m in sent if m.get("id") == 2 and "result" in m)
    assert ok["result"] == {"ok": True}
    init = next(m for m in sent if m.get("id") == 1 and "result" in m)
    assert init["result"]["capabilities"]["warmCodeIndex"] is True


def test_warm_code_index_coalesces_same_root(tmp_path: Path) -> None:
    """Two ServerWorkspace instances for the same root share one IndexMaintainer."""
    clear_index_registry()
    (tmp_path / "a.py").write_text("x = 1\n", encoding="utf-8")

    from agentcore.tools.sandbox.subprocess import SubprocessSandbox
    from agentcore.workspace.indexing.registry import shared_index_maintainer_for_dir
    from agentcore.workspace.server import ServerWorkspace

    ws1 = ServerWorkspace(root=tmp_path, sandbox=SubprocessSandbox())
    ws2 = ServerWorkspace(root=tmp_path, sandbox=SubprocessSandbox())
    ws1.start_code_index_maintenance()
    ws2.start_code_index_maintenance()
    assert ws1._index_maintainer is ws2._index_maintainer  # noqa: SLF001
    assert ws1._index_maintainer is shared_index_maintainer_for_dir(  # noqa: SLF001
        ws2.index_dir, ws2
    )


def test_initialize_schedules_warm(tmp_path: Path, monkeypatch) -> None:
    clear_index_registry()
    (tmp_path / "b.py").write_text("y = 2\n", encoding="utf-8")
    sent, write_line = _recorder()
    server = SidecarServer(write_line)
    kicks = MagicMock()
    monkeypatch.setattr(
        "agentcore.workspace.server.ServerWorkspace.start_code_index_maintenance",
        kicks,
    )

    async def run() -> None:
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "userId": "u",
                        "workspaceRoot": str(tmp_path),
                        "approvalsEnabled": True,
                    },
                }
            )
        )

    asyncio.run(run())
    kicks.assert_called_once()
    assert any(m.get("id") == 1 and "result" in m for m in sent)
