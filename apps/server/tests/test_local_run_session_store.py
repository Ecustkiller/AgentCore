"""LocalRunSessionStore round-trip (sidecar durable 留人 roster)."""

from __future__ import annotations

import asyncio

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.runs import RunSession, RunSpec
from agentcore.sidecar.run_session_store import LocalRunSessionStore


def _session(run_id: str, *, text: str = "hello") -> RunSession:
    return RunSession(
        run_id=run_id,
        spec=RunSpec(run_id=run_id, agent_id=run_id, role="写入员", task="写"),
        transcript=[LLMMessage(role="assistant", content=text)],
        content=text,
        recall_count=1,
    )


def test_local_run_session_round_trip(tmp_path):
    store = LocalRunSessionStore(tmp_path / "run_sessions")

    async def drive() -> None:
        await store.save("cid-1", _session("r1", text="正文"))
        loaded = await store.load("r1")
        assert loaded is not None
        assert loaded.run_id == "r1"
        assert loaded.content == "正文"
        assert loaded.recall_count == 1
        assert loaded.transcript[0].content == "正文"
        assert await store.load("missing") is None

    asyncio.run(drive())
