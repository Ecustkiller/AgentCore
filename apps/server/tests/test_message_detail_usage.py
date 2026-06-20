"""MessageDetail's reload projection of the row usage snapshot (Tier 2 重载持久化).

The assistant row's ``usage`` column stores a long-key token snapshot
(``{input_tokens, …, rounds}``) written by ``_persist_turn_result``. ``MessageDetail``
surfaces it on reload: the ``usage`` field is projected to the ledger short-key
``UsageBreakdown`` the client reads, and tokens show only when the turn reported real
spend — a no-spend / errored turn stored zeros, which the live bubble also omits. The
``rounds`` field shares the column but is set by the read route (no own attribute), so
it is not exercised here.
"""

from datetime import datetime, timezone

from agentcore.api.schemas.messages import MessageDetail


def _row(usage: dict | None) -> dict:
    return {
        "id": "m1",
        "conversation_id": "c1",
        "role": "assistant",
        "content": "hi",
        "created_at": datetime.now(timezone.utc),
        "usage": usage,
    }


def test_usage_row_projects_to_short_keys():
    d = MessageDetail.model_validate(
        _row(
            {
                "input_tokens": 100,
                "output_tokens": 40,
                "reasoning_tokens": 12,
                "cache_hit_tokens": 30,
                "cache_miss_tokens": 70,
                "rounds": 3,
            }
        )
    )
    assert d.usage is not None
    assert (d.usage.input, d.usage.output, d.usage.reasoning) == (100, 40, 12)
    assert (d.usage.cache_hit, d.usage.cache_miss) == (30, 70)


def test_no_spend_turn_omits_usage():
    # 报错/空回合 stored zeros → no token meta on reload, parity with the live bubble.
    d = MessageDetail.model_validate(
        _row(
            {
                "input_tokens": 0,
                "output_tokens": 0,
                "reasoning_tokens": 0,
                "cache_hit_tokens": 0,
                "cache_miss_tokens": 0,
                "rounds": 0,
            }
        )
    )
    assert d.usage is None


def test_missing_usage_column_omits_usage():
    # User rows / pre-feature rows carry no usage snapshot.
    d = MessageDetail.model_validate(_row(None))
    assert d.usage is None
