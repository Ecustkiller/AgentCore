"""Integration tests for the cost ledger write path (CostEventRepository).

Backed by a real PostgreSQL throwaway schema (auto-skips when none is reachable,
via the ``session_factory`` fixture). Pins the two properties the turn finalize
step depends on: the service envelope (user / conversation / message) is attached
to every run row, and the write is idempotent by ``run_id`` so a retried turn
never double-bills.
"""

from sqlalchemy import select

from agentcore.core.types import new_id
from agentcore.db.models import CostEvent
from agentcore.db.repositories import CostEventRepository


def _run(
    run_id: str, *, role: str = "member", parent: str | None = None, total: int = 1000
) -> dict:
    """A per-run ledger payload in the runtime's ``asdict(RunCost)`` shape."""
    return {
        "run_id": run_id,
        "parent_run_id": parent,
        "agent_id": run_id,
        "role": role,
        "model": "deepseek-v4-pro",
        "tokens": {"input": 100, "output": 50, "reasoning": 0, "cache_hit": 60, "cache_miss": 40},
        "cost": {"input": 800, "cached": 100, "output": 200, "total": total},
        "cost_total_nano": total,
        "currency": "USD",
        "rounds": 1,
        "duration_ms": 500,
    }


async def test_record_runs_persists_with_envelope(session_factory):
    user_id, conv_id, msg_id = new_id(), new_id(), new_id()
    cap_id, mem_id = new_id(), new_id()

    async with session_factory() as session:
        written = await CostEventRepository(session).record_runs(
            user_id=user_id,
            conversation_id=conv_id,
            message_id=msg_id,
            runs=[
                _run(cap_id, role="captain", total=300),
                _run(mem_id, parent=cap_id, total=1200),
            ],
        )
    assert written == 2

    async with session_factory() as session:
        rows = (
            (
                await session.execute(
                    select(CostEvent)
                    .where(CostEvent.message_id == msg_id)
                    .order_by(CostEvent.cost_total_nano)
                )
            )
            .scalars()
            .all()
        )

    assert len(rows) == 2
    captain, member = rows[0], rows[1]  # ordered by total asc (300, 1200)
    # Envelope attached by the repo (the runtime builders stay DB-unaware).
    for row in rows:
        assert row.user_id == user_id
        assert row.conversation_id == conv_id
        assert row.message_id == msg_id
        assert row.id  # minted per row (a Core bulk insert skips the ORM default)
    assert captain.role == "captain"
    assert captain.run_id == cap_id
    assert captain.parent_run_id is None
    assert member.role == "member"
    assert member.parent_run_id == cap_id
    assert member.cost_total_nano == 1200
    assert member.cost == {"input": 800, "cached": 100, "output": 200, "total": 1200}
    assert member.tokens["cache_hit"] == 60


async def test_record_runs_persists_namespaced_worker_ids(session_factory):
    # Regression: a real multi-agent turn's member/revision ids are NOT uuids —
    # delegated workers are ``del_<uuid>_N`` and revisions ``<run>_rev2``. The
    # ledger columns were once native uuid, so this single multi-row INSERT aborted
    # whole (DataError), silently dropping the turn's entire ledger — captain too.
    user_id, conv_id, msg_id = new_id(), new_id(), new_id()
    cap_id = new_id()  # captain root is a real uuid
    worker_id = f"del_{new_id()}_1"  # delegated worker — namespaced, not a uuid
    revision_id = f"{worker_id}_rev2"  # 定向唤回 续写 of that worker

    async with session_factory() as session:
        written = await CostEventRepository(session).record_runs(
            user_id=user_id,
            conversation_id=conv_id,
            message_id=msg_id,
            runs=[
                _run(cap_id, role="captain", total=300),
                _run(worker_id, parent=cap_id, total=1200),
                _run(revision_id, parent=worker_id, total=400),
            ],
        )
    assert written == 3

    async with session_factory() as session:
        rows = (
            (await session.execute(select(CostEvent).where(CostEvent.message_id == msg_id)))
            .scalars()
            .all()
        )
    by_id = {r.run_id: r for r in rows}
    assert set(by_id) == {cap_id, worker_id, revision_id}
    # the revision row hangs off its original worker (version chain reconstructable)
    assert by_id[revision_id].parent_run_id == worker_id
    assert by_id[worker_id].parent_run_id == cap_id
    assert by_id[revision_id].agent_id == revision_id


async def test_record_runs_is_idempotent_by_run_id(session_factory):
    # A retried turn re-sends the same run_ids; the second write must insert
    # nothing so a run is never double-billed (run_id unique, upsert do-nothing).
    user_id, conv_id, msg_id = new_id(), new_id(), new_id()
    run = _run(new_id(), role="captain", total=500)

    async with session_factory() as session:
        first = await CostEventRepository(session).record_runs(
            user_id=user_id, conversation_id=conv_id, message_id=msg_id, runs=[run]
        )
    async with session_factory() as session:
        second = await CostEventRepository(session).record_runs(
            user_id=user_id, conversation_id=conv_id, message_id=msg_id, runs=[run]
        )

    assert first == 1
    assert second == 0  # conflict on run_id → skipped

    async with session_factory() as session:
        rows = (
            (await session.execute(select(CostEvent).where(CostEvent.run_id == run["run_id"])))
            .scalars()
            .all()
        )
    assert len(rows) == 1


async def test_record_runs_empty_is_noop(session_factory):
    async with session_factory() as session:
        written = await CostEventRepository(session).record_runs(
            user_id=new_id(), conversation_id=new_id(), message_id=new_id(), runs=[]
        )
    assert written == 0
