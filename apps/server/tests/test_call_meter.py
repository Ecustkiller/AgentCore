"""In-process call metering: proxy scenario must not enqueue a second ledger row."""

from __future__ import annotations

from pathlib import Path

import pytest

from agentcore.billing import cost_ledger_queue as queue_mod
from agentcore.billing.call_meter import PROXY_LLM_SCENARIO, maybe_enqueue_inprocess_call
from agentcore.core.log_context import log_context
from agentcore.llm.provider.protocol import TokenUsage


class _AliveTask:
    def done(self) -> bool:
        return False


@pytest.fixture
def running_ledger(monkeypatch, tmp_path: Path):
    queue = queue_mod.reset_cost_ledger_queue_for_tests()
    monkeypatch.setattr(queue_mod.settings, "data_dir", str(tmp_path))
    queue._task = _AliveTask()
    return queue, tmp_path


def _usage() -> TokenUsage:
    return TokenUsage(input_tokens=10, output_tokens=5)


def _pending_rows(queue) -> list[dict]:
    return [r for r in queue._backend._rows.values() if r.get("status") == "pending"]


@pytest.mark.asyncio
async def test_maybe_enqueue_skips_proxy_scenario(running_ledger):
    """Proxy unary still logs llm.call, but billing is proxy_spend-only."""
    queue, _tmp_path = running_ledger
    with log_context(user_id="u1", conversation_id="c1"):
        assert (
            maybe_enqueue_inprocess_call(
                model="deepseek-v4-flash",
                usage=_usage(),
                scenario=PROXY_LLM_SCENARIO,
            )
            is None
        )
    await queue._await_pending_enqueues()
    assert _pending_rows(queue) == []


@pytest.mark.asyncio
async def test_maybe_enqueue_records_non_proxy_scenario(running_ledger):
    queue, _tmp_path = running_ledger
    with log_context(user_id="u1", conversation_id="c1"):
        rid = maybe_enqueue_inprocess_call(
            model="deepseek-v4-flash",
            usage=_usage(),
            scenario="chat",
        )
    assert rid is not None
    await queue._await_pending_enqueues()
    rows = _pending_rows(queue)
    assert len(rows) == 1
    assert rows[0]["source"] == "inprocess_call"
    assert rows[0]["materialize_runs"] is True
