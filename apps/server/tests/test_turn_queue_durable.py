"""Unstarted queue survives a process restart without storing the API key."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from agentcore.runtime.events import EventSink
from agentcore.runtime.turn.delivery import edit_queued_item, withdraw_queued_item
from agentcore.runtime.turn.durable import (
    durable_payload,
    flush_turn_queue_durable,
    install_turn_queue_store,
    queued_turn_from_record,
    reset_turn_queue_durable,
    restore_durable_turn_queue,
    set_drain_credential_resolver,
)
from agentcore.runtime.turn.queue import QueuedTurn, new_queued_turn, turn_queue
from agentcore.runtime.turn.runs import turn_runs


class _MemoryStore:
    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.allow_claim = True

    async def upsert(self, conversation_id: str, item: QueuedTurn, position: int) -> None:
        self.rows[item.queue_id] = durable_payload(conversation_id, item, position)

    async def update_payload(
        self,
        queue_id: str,
        *,
        content: str,
        attachments: list,
        agent_mentions: list,
    ) -> None:
        self.rows[queue_id]["content"] = content
        self.rows[queue_id]["attachments"] = list(attachments)
        self.rows[queue_id]["agent_mentions"] = list(agent_mentions)

    async def rewrite_order(self, conversation_id: str, queue_ids: list[str]) -> None:
        for position, queue_id in enumerate(queue_ids, start=1):
            row = self.rows.get(queue_id)
            if row is not None and row["conversation_id"] == conversation_id:
                row["position"] = position

    async def delete(self, queue_id: str) -> None:
        self.rows.pop(queue_id, None)

    async def claim_delete(self, queue_id: str) -> bool:
        if not self.allow_claim or queue_id not in self.rows:
            return False
        self.rows.pop(queue_id, None)
        return True

    async def delete_conversation(self, conversation_id: str) -> None:
        self.rows = {
            key: row
            for key, row in self.rows.items()
            if row["conversation_id"] != conversation_id
        }

    async def load(self) -> list[tuple[str, QueuedTurn]]:
        ordered = sorted(
            self.rows.values(),
            key=lambda row: (row["conversation_id"], row["position"]),
        )
        return [
            (row["conversation_id"], queued_turn_from_record(SimpleNamespace(**row)))
            for row in ordered
        ]


class _Driver:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    async def start_turn(self, **kwargs: object) -> None:
        self.calls.append((str(kwargs["user_message"]), kwargs["llm_credentials"]))


async def _never() -> None:
    await asyncio.Future()


def test_durable_payload_omits_credentials() -> None:
    item = new_queued_turn(content="hello", user_id="u", llm_credentials="secret-key")
    payload = durable_payload("c1", item, 1)
    assert "llm_credentials" not in payload
    assert "secret-key" not in json.dumps(payload)


async def test_enqueue_mirrors_text_and_edit_cancel_follow() -> None:
    cid = "c-durable-mirror"
    store = _MemoryStore()
    install_turn_queue_store(store)
    turn_queue.clear(cid)
    blocker = asyncio.create_task(_never())
    turn_runs.register(conversation_id=cid, task=blocker, sink=EventSink())
    try:
        first = new_queued_turn(content="one", user_id="u", llm_credentials="secret-key")
        second = new_queued_turn(content="two", user_id="u", llm_credentials="secret-key")
        turn_queue.enqueue_and_ensure_drain(cid, first)
        turn_queue.enqueue_and_ensure_drain(cid, second)
        await flush_turn_queue_durable()
        assert [store.rows[first.queue_id]["position"], store.rows[second.queue_id]["position"]] == [
            1,
            2,
        ]
        assert "secret-key" not in json.dumps(store.rows)

        saved = await edit_queued_item(
            cid,
            first.queue_id,
            content="one-edited",
            attachments=[],
            agent_mentions=[],
        )
        assert saved is not None
        assert store.rows[first.queue_id]["content"] == "one-edited"
        assert turn_queue.find_pending(cid, first.queue_id).content == "one-edited"  # type: ignore[union-attr]

        removed = await withdraw_queued_item(cid, second.queue_id)
        assert removed is not None
        assert second.queue_id not in store.rows
        assert turn_queue.find_pending(cid, second.queue_id) is None
    finally:
        turn_queue.clear(cid)
        blocker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await blocker
        reset_turn_queue_durable()


async def test_restore_keeps_order_and_waits_for_the_recovered_turn(monkeypatch) -> None:
    cid = "c-durable-restore"
    store = _MemoryStore()
    blocked = {"on": True}

    async def _block(_conversation_id: str) -> bool:
        return blocked["on"]

    async def _resolve(_user_id: str, _conversation_id: str, _needs_tools: bool):
        return "fresh-key", True

    driver = _Driver()
    monkeypatch.setattr(
        "agentcore.runtime.turn.driver.get_turn_driver",
        lambda: driver,
    )
    install_turn_queue_store(store, blocker=_block)
    set_drain_credential_resolver(_resolve)
    turn_queue.clear(cid)
    try:
        await store.upsert(
            cid,
            new_queued_turn(content="one", user_id="user-1", llm_credentials="secret-key"),
            1,
        )
        await store.upsert(
            cid,
            new_queued_turn(content="two", user_id="user-1", llm_credentials="secret-key"),
            2,
        )
        # The in-memory deque is what a fresh process does not have.
        assert turn_queue.depth(cid) == 0

        restored = await restore_durable_turn_queue()
        assert restored == 2
        pending = turn_queue.list_pending(cid)
        assert [item.content for item in pending] == ["one", "two"]
        assert all(item.credentials_pending and item.durable_claim for item in pending)
        assert all(item.llm_credentials is None for item in pending)

        for _ in range(10):
            await asyncio.sleep(0.02)
        assert driver.calls == []

        blocked["on"] = False
        turn_queue.schedule_drain(cid)
        for _ in range(40):
            if len(driver.calls) == 2:
                break
            await asyncio.sleep(0.025)
        assert driver.calls == [("one", "fresh-key"), ("two", "fresh-key")]
        assert store.rows == {}
    finally:
        turn_queue.clear(cid)
        reset_turn_queue_durable()


async def test_lost_durable_claim_does_not_start(monkeypatch) -> None:
    cid = "c-durable-claim"
    store = _MemoryStore()
    store.allow_claim = False
    driver = _Driver()
    monkeypatch.setattr(
        "agentcore.runtime.turn.driver.get_turn_driver",
        lambda: driver,
    )
    install_turn_queue_store(store)
    turn_queue.clear(cid)
    item = new_queued_turn(content="one", user_id="u")
    item.durable_claim = True
    turn_queue.enqueue(cid, item)
    store.rows[item.queue_id] = durable_payload(cid, item, 1)
    try:
        turn_queue.schedule_drain(cid)
        for _ in range(10):
            await asyncio.sleep(0.02)
        assert driver.calls == []
        assert turn_queue.depth(cid) == 0
        assert item.queue_id in store.rows
    finally:
        turn_queue.clear(cid)
        reset_turn_queue_durable()
