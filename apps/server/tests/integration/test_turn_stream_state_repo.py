"""turn_stream_state repository — Postgres round-trip (流式回复持久化 P0).

Auto-skips when PostgreSQL is unreachable (same fixture as other integration repos).
"""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import update

from agentcore.config import settings
from agentcore.db.models.runs import TurnStreamStateRow
from agentcore.db.repositories import TurnStreamStateRepository
from agentcore.runtime import stream_state_retention as retention_mod


async def test_upsert_monotonic_same_generation(session_factory):
    turn_id = str(uuid4())
    channel = "captain:content"
    async with session_factory() as s:
        repo = TurnStreamStateRepository(s)
        assert await repo.upsert(turn_id=turn_id, channel=channel, text="ab", generation=0)
        assert not await repo.upsert(turn_id=turn_id, channel=channel, text="a", generation=0)
        assert await repo.upsert(turn_id=turn_id, channel=channel, text="abc", generation=0)
        rows = await repo.list_for_turn(turn_id)
    assert len(rows) == 1
    assert rows[0].text == "abc"
    assert rows[0].generation == 0


async def test_upsert_generation_reset_clears(session_factory):
    turn_id = str(uuid4())
    channel = "captain:reasoning"
    async with session_factory() as s:
        repo = TurnStreamStateRepository(s)
        assert await repo.upsert(
            turn_id=turn_id, channel=channel, text="thinking…", generation=0
        )
        assert await repo.upsert(turn_id=turn_id, channel=channel, text="", generation=1)
        rows = await repo.list_for_turn(turn_id)
    assert len(rows) == 1
    assert rows[0].text == ""
    assert rows[0].generation == 1


async def test_list_and_delete_for_turn(session_factory):
    turn_id = str(uuid4())
    async with session_factory() as s:
        repo = TurnStreamStateRepository(s)
        await repo.upsert(turn_id=turn_id, channel="captain:content", text="c", generation=0)
        await repo.upsert(turn_id=turn_id, channel="captain:reasoning", text="r", generation=0)
        rows = await repo.list_for_turn(turn_id)
        assert {r.channel for r in rows} == {"captain:content", "captain:reasoning"}
        deleted = await repo.delete_for_turn(turn_id)
        assert deleted == 2
        assert await repo.list_for_turn(turn_id) == []


async def test_retention_sweep_prunes_aged_and_batches(session_factory, monkeypatch):
    monkeypatch.setattr(retention_mod, "async_session_factory", session_factory)
    monkeypatch.setattr(settings, "turn_stream_state_retention_days", 7)
    monkeypatch.setattr(settings, "turn_stream_state_sweep_batch_limit", 2)
    aged_ids = [str(uuid4()) for _ in range(3)]
    fresh_id = str(uuid4())

    async with session_factory() as s:
        repo = TurnStreamStateRepository(s)
        for mid in (*aged_ids, fresh_id):
            await repo.upsert(turn_id=mid, channel="captain:content", text="x", generation=0)

    aged = datetime.now(UTC) - timedelta(days=10)
    async with session_factory() as s:
        await s.execute(
            update(TurnStreamStateRow)
            .where(TurnStreamStateRow.turn_id.in_(aged_ids))
            .values(updated_at=aged)
        )
        await s.commit()

    deleted = await retention_mod.run_stream_state_retention_sweep()

    assert deleted == 3
    async with session_factory() as s:
        repo = TurnStreamStateRepository(s)
        assert len(await repo.list_for_turn(fresh_id)) == 1
        for mid in aged_ids:
            assert await repo.list_for_turn(mid) == []


async def test_retention_sweep_noop_when_disabled(session_factory, monkeypatch):
    monkeypatch.setattr(retention_mod, "async_session_factory", session_factory)
    monkeypatch.setattr(settings, "turn_stream_state_retention_days", 0)
    assert await retention_mod.run_stream_state_retention_sweep() == 0
