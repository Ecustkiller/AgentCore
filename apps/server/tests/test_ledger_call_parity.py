"""Cross-path ledger assembly: in-process meter vs proxy spend must agree.

Pins the P4-B contract — two enqueue sources stay (deployment shape), but
token / cache / attribution / money fields assemble through one helper.
"""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

import pytest

from agentcore.billing import cost_ledger_queue as ledger_mod
from agentcore.billing import proxy_spend_queue as proxy_mod
from agentcore.billing.attribution import resolve_ledger_role
from agentcore.billing.call_meter import maybe_enqueue_inprocess_call
from agentcore.billing.ledger_call import assemble_ledger_call
from agentcore.core.log_context import log_context
from agentcore.llm.provider.protocol import TokenUsage
from agentcore.runtime.costing import ROLE_CAPTAIN, ROLE_MEMBER, ROLE_TITLE

# Fields that must match across call surfaces for the same physical usage.
_COMPARE_KEYS = (
    "run_id",
    "parent_run_id",
    "agent_id",
    "role",
    "persona",
    "model",
    "tokens",
    "cost",
    "cost_total_nano",
    "cost_estimated_nano",
    "currency",
    "duration_ms",
    "platform_credential_id",
)


class _AliveTask:
    def done(self) -> bool:
        return False


def _pending_rows(queue) -> list[dict]:
    return [r for r in queue._backend._rows.values() if r.get("status") == "pending"]


def _usage_with_cache() -> TokenUsage:
    return TokenUsage(
        input_tokens=1000,
        output_tokens=200,
        reasoning_tokens=50,
        cache_hit_tokens=400,
        cache_miss_tokens=600,
    )


@pytest.fixture
def running_ledger(monkeypatch, tmp_path: Path):
    queue = ledger_mod.reset_cost_ledger_queue_for_tests()
    monkeypatch.setattr(ledger_mod.settings, "data_dir", str(tmp_path))
    queue._task = _AliveTask()
    return queue


def test_resolve_ledger_role_explicit_and_structural():
    assert resolve_ledger_role(role="title") == ROLE_TITLE
    assert resolve_ledger_role(role="member", agent_id="CEO") == ROLE_MEMBER
    assert resolve_ledger_role(role="hacker", agent_id="CEO") == ROLE_CAPTAIN
    assert resolve_ledger_role(role=None, agent_id="del_1", run_id=None) == ROLE_MEMBER
    assert resolve_ledger_role(role="", agent_id=None, run_id=None) == ROLE_CAPTAIN


def test_assemble_ledger_call_prices_cache_split_and_attribution():
    call = assemble_ledger_call(
        model="deepseek-v4-flash",
        usage=_usage_with_cache(),
        role="member",
        run_id="del_1",
        parent_run_id="cap_1",
        agent_id="del_1",
        persona="调研员",
        call_id="call_stable",
        duration_ms=42,
        credential_source="platform",
    )
    assert call.call_id == "call_stable"
    assert call.role == ROLE_MEMBER
    assert call.persona == "调研员"
    assert call.tokens["input"] == 1000
    assert call.tokens["cache_hit"] == 400
    assert call.tokens["cache_miss"] == 600
    assert call.tokens["reasoning"] == 50
    assert call.cost_total_nano > 0
    assert call.cost_estimated_nano == 0
    assert call.cost["credential_source"] == "platform"
    assert call.duration_ms == 42


def test_assemble_byok_routes_money_to_estimated():
    call = assemble_ledger_call(
        model="deepseek-v4-flash",
        usage=_usage_with_cache(),
        credential_source="user",
    )
    assert call.cost_total_nano == 0
    assert call.cost_estimated_nano > 0
    assert call.cost["credential_source"] == "user"


@pytest.mark.asyncio
async def test_inprocess_and_proxy_enqueue_agree_on_call_fields(running_ledger):
    """Same usage + attribution → identical CallCost fields; only ``source`` differs."""
    usage = _usage_with_cache()
    attrs = dict(
        run_id="del_worker_1",
        parent_run_id="cap_1",
        agent_id="del_worker_1",
        persona="调研员",
        call_id="call_cross_path",
        duration_ms=17,
        credential_source="platform",
    )

    with log_context(
        user_id="u1",
        conversation_id="c1",
        message_id="m1",
        trace_id="tr1",
        cost_role="member",
        **{k: attrs[k] for k in ("run_id", "parent_run_id", "agent_id", "persona")},
    ):
        in_id = maybe_enqueue_inprocess_call(
            model="deepseek-v4-flash",
            usage=usage,
            duration_ms=attrs["duration_ms"],
            scenario="agent",
            credential_source=attrs["credential_source"],
        )
    assert in_id is not None

    proxy = proxy_mod.ProxySpendQueue(running_ledger)
    proxy_id = proxy.enqueue(
        user_id="u1",
        conversation_id="c1",
        model="deepseek-v4-flash",
        usage=usage,
        message_id="m1",
        trace_id="tr1",
        role="member",
        **attrs,
    )
    assert proxy_id is not None

    await running_ledger._await_pending_enqueues()
    rows = _pending_rows(running_ledger)
    assert len(rows) == 2
    by_source = {r["source"]: r for r in rows}
    assert set(by_source) == {"inprocess_call", "proxy_spend"}

    in_call = by_source["inprocess_call"]["calls"][0]
    proxy_call = by_source["proxy_spend"]["calls"][0]
    # In-process mints call_id (no header); proxy carries the stable id.
    assert proxy_call["call_id"] == "call_cross_path"
    assert in_call["call_id"].startswith("call_")
    for key in _COMPARE_KEYS:
        assert in_call[key] == proxy_call[key], f"mismatch on {key}"
    for payload in by_source.values():
        assert payload["materialize_runs"] is True
        assert payload["message_id"] == "m1"
        assert payload["trace_id"] == "tr1"


def test_assemble_is_single_source_for_both_facades():
    """Direct assemble ≡ what each facade would stamp (role default drift locked)."""
    usage = TokenUsage(input_tokens=10, output_tokens=2)
    shared = asdict(
        assemble_ledger_call(
            model="deepseek-v4-flash",
            usage=usage,
            agent_id="del_only",
            credential_source="platform",
            call_id="call_lock",
        )
    )
    # agent_id without run_id → member (was captain on the old in-process branch).
    assert shared["role"] == ROLE_MEMBER
    assert shared["call_id"] == "call_lock"
