"""Per-model probe: classification, the probed set, and what the catalog does with it.

The bug these pin: a profile pinned to an id the provider retired kept failing
every turn with the vendor's raw 404, while the catalog listed the model as
available. Three things have to hold — a verdict that distinguishes "gone" from
"busy", a probed set small enough to be affordable, and a catalog that only
greys out what is truly gone.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from agentcore.llm import model_health
from agentcore.llm.catalog import _provider_entries
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.model_health import (
    STATUS_DEAD,
    STATUS_ERROR,
    STATUS_OK,
    STATUS_THROTTLED,
    ProbeOutcome,
    RecordedVerdict,
    _arm_free_quota_hold,
    _due_models,
    _models_to_probe,
    _parse_reset_header,
    classify_probe,
    free_quota_held_off,
    is_free_model,
    reset_free_quota_hold,
)

OPENROUTER = "https://openrouter.ai/api/v1"


@pytest.mark.parametrize(
    ("status_code", "body", "expected_status", "expected_detail"),
    [
        (200, '{"choices":[]}', STATUS_OK, None),
        (
            404,
            '{"error":{"message":"x is no longer available on OpenRouter: '
            'no provider serves this model anymore"}}',
            STATUS_DEAD,
            "model_retired",
        ),
        (
            404,
            '{"error":{"message":"This model is unavailable for free. The paid '
            'version is available now - use this slug instead: z-ai/glm-5.2"}}',
            STATUS_DEAD,
            "model_retired",
        ),
        # A 404 without a "this model is gone" phrase is usually a base_url that
        # lost its version prefix. Accusing the model there would grey a whole
        # catalog over one typo.
        (404, "<html>Not Found</html>", STATUS_ERROR, "endpoint_404"),
        (429, '{"error":{"message":"rate limited"}}', STATUS_THROTTLED, "rate_limited"),
        # A drained daily allowance is not a busy minute. OpenRouter names it, and
        # the picker has to say "come back after the reset", not "retry soon".
        (
            429,
            '{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 '
            'credits to unlock 1000 free model requests per day","code":429}}',
            STATUS_THROTTLED,
            "free_quota_exhausted",
        ),
        (401, '{"error":{"message":"invalid api key"}}', STATUS_ERROR, "auth_rejected"),
        # 403 comes in two flavours; only one of them is the key's fault.
        (
            403,
            '{"error":{"message":"The request is prohibited due to a violation of '
            'provider Terms Of Service."}}',
            STATUS_ERROR,
            "region_blocked",
        ),
        (403, '{"error":{"message":"API key does not have access"}}', STATUS_ERROR, "auth_rejected"),
        (402, '{"error":{"message":"insufficient credits"}}', STATUS_ERROR, "insufficient_balance"),
        (503, "upstream down", STATUS_ERROR, "upstream_error"),
        (418, "teapot", STATUS_ERROR, "http_418"),
    ],
)
def test_classify_probe(status_code, body, expected_status, expected_detail):
    outcome = classify_probe(status_code, body)
    assert outcome.status == expected_status
    assert outcome.detail == expected_detail


def _profile(name, provider_id, main, worker=None, background=None):
    return SimpleNamespace(
        name=name,
        main_provider_id=provider_id,
        main_model=main,
        worker_provider_id=provider_id if worker else None,
        worker_model=worker,
        background_provider_id=provider_id if background else None,
        background_model=background,
    )


def test_probed_set_is_profile_pins_plus_preset_seeds():
    """Only ids the user runs or the picker seeds — never a whole marketplace."""
    models = _models_to_probe(
        profiles=[
            _profile("glm", "p1", "nvidia/nemotron-3-ultra-550b-a55b:free"),
            _profile("other", "p2", "some/other-model"),
        ],
        provider_id="p1",
        base_url=OPENROUTER,
    )
    # The p2 profile belongs to another endpoint and must not be probed here.
    assert "some/other-model" not in models
    assert "nvidia/nemotron-3-ultra-550b-a55b:free" in models
    # Preset seeds come along so a fresh id is checked before anyone picks it.
    assert "openrouter/auto" in models
    assert len(models) == len(set(models))


def test_probed_set_skips_blank_and_unions_slots():
    models = _models_to_probe(
        profiles=[_profile("combo", "p1", "m-main", worker="m-worker", background="m-main")],
        provider_id="p1",
        base_url="https://api.example.com/v1",
    )
    assert models == ["m-main", "m-worker"]


def _recorded(status, detail, *, age_seconds):
    return RecordedVerdict(
        status=status,
        detail=detail,
        checked_at=datetime.now(UTC) - timedelta(seconds=age_seconds),
    )


def test_is_free_model_reads_the_suffix():
    assert is_free_model("nvidia/nemotron-3.5-lightning:free")
    assert is_free_model("  cohere/north-mini-code:FREE ")
    assert not is_free_model("openrouter/auto")
    assert not is_free_model("google/gemini-2.5-pro")


def test_parse_reset_header_accepts_ms_and_seconds():
    now = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)
    reset = datetime(2026, 11, 5, 0, 0, tzinfo=UTC)
    assert _parse_reset_header(str(int(reset.timestamp() * 1000)), now=now) == reset
    assert _parse_reset_header(str(int(reset.timestamp())), now=now) == reset
    # Already in the past / nonsense → no hold at all.
    assert _parse_reset_header(str(int((now - timedelta(hours=1)).timestamp() * 1000)), now=now) is None
    assert _parse_reset_header("soon", now=now) is None
    assert _parse_reset_header(None, now=now) is None


def test_free_quota_hold_is_armed_only_by_a_proven_empty_pool():
    reset_free_quota_hold()
    try:
        now = datetime.now(UTC)
        # Ordinary throttling is weather: it must not silence the whole sweep.
        _arm_free_quota_hold(
            ProbeOutcome(STATUS_THROTTLED, "rate_limited", 120), now=now
        )
        assert free_quota_held_off(now) is False

        until = now + timedelta(hours=6)
        _arm_free_quota_hold(
            ProbeOutcome(STATUS_THROTTLED, "free_quota_exhausted", 80, until), now=now
        )
        assert free_quota_held_off(now) is True
        assert free_quota_held_off(until - timedelta(seconds=1)) is True
        # The hold expires on its own at the provider's reset moment.
        assert free_quota_held_off(until) is False
    finally:
        reset_free_quota_hold()


def test_free_quota_hold_falls_back_when_no_reset_header():
    reset_free_quota_hold()
    try:
        now = datetime.now(UTC)
        _arm_free_quota_hold(
            ProbeOutcome(STATUS_THROTTLED, "free_quota_exhausted", 80), now=now
        )
        assert free_quota_held_off(now + timedelta(minutes=30)) is True
        assert free_quota_held_off(now + timedelta(hours=2)) is False
    finally:
        reset_free_quota_hold()


def test_due_models_spends_requests_where_they_buy_information():
    """The whole point: a sweep must not cost more than the allowance it measures."""
    now = datetime.now(UTC)
    recorded = {
        # Stable verdict on a free id: trust it for half a day.
        "nvidia/nemotron-3.5-lightning:free": _recorded(STATUS_OK, None, age_seconds=3600),
        # Same verdict, older than the free window → ask again.
        "cohere/north-mini-code:free": _recorded(STATUS_OK, None, age_seconds=13 * 3600),
        # Paid ids change on the same schedule but cost nothing to ask.
        "openrouter/auto": _recorded(STATUS_OK, None, age_seconds=3 * 3600),
        # Weather: re-check on the short window, not the free one.
        "dots-studio/dots-3-note-preview:free": _recorded(
            STATUS_THROTTLED, "rate_limited", age_seconds=3600
        ),
        # A window statement, not a verdict → always re-ask once the window rolls.
        "nvidia/nemotron-3.5-super-vl:free": _recorded(
            STATUS_THROTTLED, "free_quota_exhausted", age_seconds=60
        ),
    }
    models = [*recorded, "google/gemini-2.5-pro"]  # last one was never probed

    due = _due_models(models, recorded, now=now, force=False)
    assert "nvidia/nemotron-3.5-lightning:free" not in due
    assert "cohere/north-mini-code:free" in due
    assert "openrouter/auto" in due
    # 1h-old weather on a 2h window is still fresh.
    assert "dots-studio/dots-3-note-preview:free" not in due
    assert "nvidia/nemotron-3.5-super-vl:free" in due
    assert "google/gemini-2.5-pro" in due

    # The manual "re-check" button means now, for everything.
    assert _due_models(models, recorded, now=now, force=True) == models


async def test_probe_models_stops_asking_once_the_pool_is_empty(monkeypatch):
    """One 429 must end the batch, not start five more identical ones.

    The measured failure: nine free ids probed every half hour drained an
    allowance of 50 requests *per day*, and the picker then blamed the models.
    """
    asked: list[str] = []

    async def fake_probe(_client, *, base_url, api_key, model):
        asked.append(model)
        return ProbeOutcome(
            STATUS_THROTTLED,
            "free_quota_exhausted",
            90,
            datetime.now(UTC) + timedelta(hours=1),
        )

    reset_free_quota_hold()
    try:
        monkeypatch.setattr(model_health, "probe_model", fake_probe)
        batch = await model_health.probe_models(
            base_url=OPENROUTER,
            api_key="sk-test",
            models=["a:free", "b:free", "c:free"],
            recorded={},
        )
    finally:
        reset_free_quota_hold()

    assert asked == ["a:free"]
    assert batch.held == ("b:free", "c:free")
    # The held ids are still described: the allowance is per account, so "empty"
    # is the true answer for them and a stale ok would be the lie.
    assert {m: o.detail for m, o in batch.results.items()} == {
        "a:free": "free_quota_exhausted",
        "b:free": "free_quota_exhausted",
        "c:free": "free_quota_exhausted",
    }


def _row(provider_id="p1", label="OpenRouter"):
    return SimpleNamespace(id=provider_id, label=label)


def _creds(base_url=OPENROUTER):
    return LLMCredentials(api_key="sk-test", base_url=base_url, default_model="openrouter/auto")


def _probe(status, detail=None):
    return SimpleNamespace(status=status, detail=detail, checked_at=None)


def test_dead_rows_grey_out_and_busy_rows_stay_selectable():
    entries = _provider_entries(
        _row(),
        _creds(),
        ["nvidia/nemotron-3.5-lightning:free"],
        health={
            ("p1", "nvidia/nemotron-3.5-lightning:free"): _probe("dead", "model_retired"),
            ("p1", "openrouter/auto"): _probe("throttled", "rate_limited"),
            ("p1", "cohere/north-mini-code:free"): _probe("error", "region_blocked"),
        },
    )
    by_id = {e.id: e for e in entries}

    dead = by_id["nvidia/nemotron-3.5-lightning:free"]
    assert dead.available is False
    assert dead.unavailable_reason is not None
    assert dead.unavailable_reason.code == "model_unavailable"
    assert dead.unavailable_reason.detail == "model_retired"

    # A 429 and a region block are the provider's weather, not a verdict on the
    # model — they must stay selectable, just labelled.
    for mid in ("openrouter/auto", "cohere/north-mini-code:free"):
        entry = by_id[mid]
        assert entry.available is True
        assert entry.health is not None
        assert entry.unavailable_reason is None

    # Never probed → no verdict at all (not a fake "ok").
    assert by_id["nvidia/nemotron-3-ultra-550b-a55b:free"].health is None
