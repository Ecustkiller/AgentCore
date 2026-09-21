"""Sidecar warmLlmHttp RPC schedules a TLS handshake without blocking stdin."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from agentcore.sidecar.protocol import NOT_INITIALIZED
from agentcore.sidecar.server import SidecarServer

_INFERENCE = {
    "baseUrl": "http://proxy.test/v1/inference/v1",
    "apiKey": "tok-warm",
    "model": "flash",
}


def _recorder() -> tuple[list[dict[str, Any]], Any]:
    sent: list[dict[str, Any]] = []

    async def write_line(line: str) -> None:
        sent.append(json.loads(line))

    return sent, write_line


async def _drain(server: SidecarServer) -> None:
    pending = list(server._pending_sends)
    if pending:
        await asyncio.gather(*pending)


def test_warm_llm_http_requires_initialize() -> None:
    sent, write_line = _recorder()
    server = SidecarServer(write_line)

    async def run() -> None:
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "warmLlmHttp",
                    "params": {"inference": _INFERENCE},
                }
            )
        )

    asyncio.run(run())
    err = next(m for m in sent if m.get("id") == 2 and "error" in m)
    assert err["error"]["code"] == NOT_INITIALIZED


def test_initialize_advertises_warm_llm_http_without_scheduling(
    tmp_path: Path, monkeypatch
) -> None:
    (tmp_path / "x.py").write_text("x = 1\n", encoding="utf-8")
    called: list[tuple[str, str | None]] = []

    async def fake_warm(url: str, authorization: str | None = None) -> bool:
        called.append((url, authorization))
        return True

    monkeypatch.setattr("agentcore.llm.http_pool.warm_llm_origin", fake_warm)
    sent, write_line = _recorder()
    server = SidecarServer(write_line)

    async def run() -> None:
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "userId": "local",
                        "workspaceRoot": str(tmp_path),
                        "approvalsEnabled": True,
                        "inference": _INFERENCE,
                    },
                }
            )
        )
        await asyncio.sleep(0)
        await _drain(server)

    asyncio.run(run())
    init = next(m for m in sent if m.get("id") == 1 and "result" in m)
    assert init["result"]["capabilities"]["warmLlmHttp"] is True
    assert called == []


def test_warm_llm_http_replies_then_binds_inference(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "x.py").write_text("x = 1\n", encoding="utf-8")
    gate = asyncio.Event()
    called: list[tuple[str, str | None]] = []

    async def fake_warm(url: str, authorization: str | None = None) -> bool:
        called.append((url, authorization))
        await gate.wait()
        return True

    monkeypatch.setattr("agentcore.llm.http_pool.warm_llm_origin", fake_warm)
    sent, write_line = _recorder()
    server = SidecarServer(write_line)

    async def run() -> None:
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "userId": "local",
                        "workspaceRoot": str(tmp_path),
                        "approvalsEnabled": True,
                    },
                }
            )
        )
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "warmLlmHttp",
                    "params": {"inference": _INFERENCE},
                }
            )
        )
        ok = next(m for m in sent if m.get("id") == 2 and "result" in m)
        assert ok["result"] == {"ok": True}
        assert not gate.is_set()
        gate.set()
        await _drain(server)

    asyncio.run(run())
    assert called == [(_INFERENCE["baseUrl"], _INFERENCE["apiKey"])]


def test_warm_llm_http_without_creds_still_ok(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "x.py").write_text("x = 1\n", encoding="utf-8")
    called: list[object] = []

    async def fake_warm(*_a: object, **_k: object) -> bool:
        called.append(True)
        return True

    monkeypatch.setattr("agentcore.llm.http_pool.warm_llm_origin", fake_warm)
    sent, write_line = _recorder()
    server = SidecarServer(write_line)

    async def run() -> None:
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "userId": "local",
                        "workspaceRoot": str(tmp_path),
                        "approvalsEnabled": True,
                    },
                }
            )
        )
        await server.handle_line(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "warmLlmHttp",
                    "params": {},
                }
            )
        )
        await _drain(server)

    asyncio.run(run())
    ok = next(m for m in sent if m.get("id") == 2 and "result" in m)
    assert ok["result"] == {"ok": True}
    assert called == []
