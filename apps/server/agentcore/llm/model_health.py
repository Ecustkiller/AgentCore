"""Is that model id still alive? Probe it, and remember the answer.

Free tiers rotate. OpenRouter retired `z-ai/glm-5.2:free`,
`qwen/qwen3.8-27b:free` and `inclusionai/ling-3.0-flash-sante:free` under a
profile that kept pointing at them, so every turn answered with the vendor's raw
""This model is unavailable for free"" and nothing in the product said the model
was gone. The catalog cannot catch this on its own: a *seeded* id is listed
whether or not it exists, and discovery only knows what the provider currently
advertises.

So something has to ask. This module probes a bounded set — the ids the user's
profiles actually pin, plus the preset seeds for the configured endpoint — and
records the verdict in ``llm_model_health``. The picker then greys out what
stopped answering instead of letting the user discover it one 404 at a time.

Three decisions worth stating:

- **Raw HTTP, not the provider leaf.** A probe must be invisible to the real
  call path: going through ``OpenAICompatibleProvider`` would spend the retry
  budget and, on a 429, arm the credential cooldown — a health check that can
  bench a working key is worse than no health check. The request shape is copied
  from the leaf on purpose (same headers, same minimal body), so a probe still
  proves what a turn would hit.
- **No tools in the probe.** Tool support is a separate, already-recorded axis
  (``user_llm_providers.supports_tools``). Sending a dummy tool here would mix
  ""this model is gone"" with ""this model cannot call tools"" and grey out
  models that are fine for the tool-free slots.
- **Only ``dead`` greys a model out.** A 429 or a 5xx is the provider having a
  bad minute; the model is still there and hiding it would be its own lie.

A fourth one learned the hard way: **a health check must not eat the thing it
measures.** The first cut re-probed everything every 30 minutes, which for an
OpenRouter account with no topped-up balance means 9 free ids x 48 sweeps
against a pool of 50 free requests *per day* — the probes drained the quota, and
every free model then correctly reported 429. A picker that says "rate limited"
about all nine models because the health check asked is worse than no picker.
So: free ids are re-probed rarely (they change slowly), a verdict that has
already survived a check is trusted for longer than a flaky one, and once a probe
proves the *daily free pool* is empty every other free id is held off until the
provider's own reset timestamp instead of being asked in turn.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final, Literal, Protocol

import httpx

from agentcore.config.settings import settings
from agentcore.core.logging import get_logger
from agentcore.llm.byok_provider_presets import preset_models_for_base_url
from agentcore.llm.provider.openai_compatible import _leaf_http_headers

logger = get_logger(__name__)

HealthStatus = Literal["ok", "dead", "throttled", "error"]

STATUS_OK: Final[HealthStatus] = "ok"
STATUS_DEAD: Final[HealthStatus] = "dead"
STATUS_THROTTLED: Final[HealthStatus] = "throttled"
STATUS_ERROR: Final[HealthStatus] = "error"

# Short on purpose: a probe that takes 60s is a probe that blocks the cycle. A
# healthy endpoint answers a one-token completion well inside this.
PROBE_TIMEOUT_SECONDS = 25.0
PROBE_CONNECT_TIMEOUT_SECONDS = 8.0
_PROBE_MAX_TOKENS = 8
_PROBE_MESSAGE = "ping"
_PROBE_CONCURRENCY = 4

# 404 bodies that mean "this id is not servable", in the vendors' own words. The
# distinction matters: a 404 on a *wrong* base path (no ``/v1``, typos) answers
# every model the same way, and marking those dead would grey out a whole
# catalog over one bad setting. Only a 404 whose body names a missing model
# counts as ``dead``; anything else stays ``error``.
_RETIRED_HINTS = (
    "no longer available",
    "unavailable for free",
    "not a valid model",
    "model not found",
    "does not exist",
    "invalid model",
    "no endpoints found",
)


_REGION_HINTS = (
    "terms of service",
    "prohibited",
    "not available in your",
    "unsupported country",
    "region",
)

# A 429 has two very different meanings and the picker must not conflate them.
# "You asked too fast" clears itself; "the free pool for today is empty" does
# not, and it covers *every* free id on the account at once. OpenRouter says so
# in the body: "Rate limit exceeded: free-models-per-day".
_QUOTA_HINTS = ("free-models-per-day", "free_tier", "free-model", "free model")

# Good and gone are stable answers: both change on the vendor's schedule (a
# retirement notice, a restock), not on the minute. Throttled/error are the
# weather and get re-checked on the shorter interval.
_STABLE_STATUSES: Final[frozenset[str]] = frozenset({STATUS_OK, STATUS_DEAD})
_FREE_MODEL_SUFFIX = ":free"

# If the provider does not tell us when the pool refills, wait an hour before
# asking again. Cheap to be wrong (one request), expensive to be wrong the other
# way (nine requests every half hour against an empty pool).
_QUOTA_HOLD_FALLBACK = timedelta(hours=1)
_QUOTA_HOLD_MAX = timedelta(hours=26)


@dataclass(frozen=True)
class ProbeOutcome:
    status: HealthStatus
    # Short, already-safe diagnosis. Never a key, never a full upstream body.
    detail: str | None
    latency_ms: int | None
    # When a quota-exhausted 429 names its reset moment, carry it so the sweep
    # can stand down until then instead of rediscovering the same wall.
    retry_at: datetime | None = None


def is_free_model(model_id: str) -> bool:
    """True for ``:free`` variants — the ones drawn from a daily allowance.

    Suffix matching rather than a provider rule: the endpoint that hurts is
    whichever one bills a shared daily pool, and every vendor that has one labels
    it in the id.
    """
    return model_id.strip().lower().endswith(_FREE_MODEL_SUFFIX)


def _parse_reset_header(raw: str | None, *, now: datetime) -> datetime | None:
    """OpenRouter sends epoch *milliseconds*; be tolerant of seconds too."""
    if not raw:
        return None
    try:
        value = float(raw.strip())
    except (TypeError, ValueError):
        return None
    # Anything below ~2001 in ms or above ~2100 in s is a unit mix-up, not a date.
    candidate = value / 1000.0 if value > 1e11 else value
    try:
        reset = datetime.fromtimestamp(candidate, UTC)
    except (OverflowError, OSError, ValueError):
        return None
    if reset <= now:
        return None
    return min(reset, now + _QUOTA_HOLD_MAX)


# Process-wide, because the allowance is per account, not per provider row: one
# exhausted pool silences every free id on the same key. Reset when the window
# is over, and re-armed by whichever probe rediscovers it.
_free_quota_reset_at: datetime | None = None


def free_quota_held_off(now: datetime | None = None) -> bool:
    """True while a proven-empty free pool has not reached its reset moment."""
    moment = now or datetime.now(UTC)
    return _free_quota_reset_at is not None and moment < _free_quota_reset_at


def _arm_free_quota_hold(outcome: ProbeOutcome, *, now: datetime) -> None:
    global _free_quota_reset_at
    if outcome.detail != "free_quota_exhausted":
        return
    until = outcome.retry_at or (now + _QUOTA_HOLD_FALLBACK)
    if _free_quota_reset_at is None or until > _free_quota_reset_at:
        logger.info("llm.model_probe_quota_hold", until=until.isoformat())
        _free_quota_reset_at = until


def reset_free_quota_hold() -> None:
    """Test seam — the hold is process state, so tests must be able to clear it."""
    global _free_quota_reset_at
    _free_quota_reset_at = None


def classify_probe(status_code: int, body: str) -> ProbeOutcome:
    """Map one HTTP answer onto (status, detail). Pure — pinned by tests."""
    text = (body or "").lower()
    if status_code == 200:
        return ProbeOutcome(STATUS_OK, None, None)
    if status_code == 404:
        if any(hint in text for hint in _RETIRED_HINTS):
            return ProbeOutcome(STATUS_DEAD, "model_retired", None)
        # Ambiguous 404: usually a base_url missing its version prefix. Say so
        # instead of accusing the model.
        return ProbeOutcome(STATUS_ERROR, "endpoint_404", None)
    if status_code == 429:
        # A drained daily pool is not a busy minute: retrying in five minutes
        # cannot help, and every other free id on the key is about to answer the
        # same way. Name it so the picker can say something actionable.
        if any(hint in text for hint in _QUOTA_HINTS):
            return ProbeOutcome(STATUS_THROTTLED, "free_quota_exhausted", None)
        return ProbeOutcome(STATUS_THROTTLED, "rate_limited", None)
    if status_code in (401, 403):
        # Two different 403s live here. One is the key (wrong, or missing a
        # scope) and is endpoint-wide; the other is the vendor refusing this
        # egress region — a model that answers everywhere else and nowhere from
        # here. Blaming the key for the second sends the user to re-paste a
        # working credential.
        if any(hint in text for hint in _REGION_HINTS):
            return ProbeOutcome(STATUS_ERROR, "region_blocked", None)
        return ProbeOutcome(STATUS_ERROR, "auth_rejected", None)
    if status_code == 402:
        return ProbeOutcome(STATUS_ERROR, "insufficient_balance", None)
    if status_code >= 500:
        return ProbeOutcome(STATUS_ERROR, "upstream_error", None)
    return ProbeOutcome(STATUS_ERROR, f"http_{status_code}", None)


async def probe_model(
    client: httpx.AsyncClient, *, base_url: str, api_key: str, model: str
) -> ProbeOutcome:
    """One model, one request. Never raises — an unreachable host is a status."""
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = _leaf_http_headers(api_key=api_key, base_url=base_url, extra=None)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": _PROBE_MESSAGE}],
        "max_tokens": _PROBE_MAX_TOKENS,
        "stream": False,
    }
    started = time.monotonic()
    try:
        resp = await client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException:
        return ProbeOutcome(STATUS_ERROR, "timeout", None)
    except httpx.HTTPError as e:
        logger.info("llm.model_probe_unreachable", model=model, error=type(e).__name__)
        return ProbeOutcome(STATUS_ERROR, "unreachable", None)
    latency_ms = int((time.monotonic() - started) * 1000)
    outcome = classify_probe(resp.status_code, resp.text)
    retry_at = None
    if outcome.detail == "free_quota_exhausted":
        retry_at = _parse_reset_header(
            resp.headers.get("X-RateLimit-Reset"), now=datetime.now(UTC)
        )
    return ProbeOutcome(outcome.status, outcome.detail, latency_ms, retry_at)


class _ProfileSlots(Protocol):
    """The three (provider, model) pairs a profile pins — duck-typed on purpose.

    The ORM row satisfies this; so does a plain namespace in a test. This module
    only needs the slots, so it must not import the table to say so (see
    ``test_arch_boundaries.test_llm_gateway_does_not_import_db``). Declared as
    read-only properties because that is all we do with them: a mutable attribute
    would demand invariance and reject the ORM's non-null ``main_model``.
    """

    @property
    def main_provider_id(self) -> str | None: ...
    @property
    def main_model(self) -> str | None: ...
    @property
    def worker_provider_id(self) -> str | None: ...
    @property
    def worker_model(self) -> str | None: ...
    @property
    def background_provider_id(self) -> str | None: ...
    @property
    def background_model(self) -> str | None: ...


@dataclass(frozen=True)
class RecordedVerdict:
    """The last stored answer for one model — again, without the table."""

    status: str
    detail: str | None
    checked_at: datetime | None


def _models_to_probe(
    *, profiles: Sequence[_ProfileSlots], provider_id: str, base_url: str
) -> list[str]:
    """Profile-pinned ids for this provider ∪ the preset seeds for its endpoint.

    The union is deliberate: a profile tells us what the user actually runs, and
    the seed tells us what the picker will offer before anything is selected.
    Anything else (hundreds of discovered ids) is left alone — probing a whole
    marketplace every half hour would cost more than it explains, and would walk
    straight into the rate limits it is trying to measure.
    """
    seen: list[str] = []
    for profile in profiles:
        for slot_provider, slot_model in (
            (profile.main_provider_id, profile.main_model),
            (profile.worker_provider_id, profile.worker_model),
            (profile.background_provider_id, profile.background_model),
        ):
            if slot_provider == provider_id and slot_model and slot_model not in seen:
                seen.append(slot_model)
    for model_id in preset_models_for_base_url(base_url):
        if model_id and model_id not in seen:
            seen.append(model_id)
    return seen


def _ttl_for(model_id: str, status: str | None) -> float:
    """How long a recorded verdict is worth trusting before asking again."""
    if is_free_model(model_id) and status in _STABLE_STATUSES:
        return settings.llm_model_health_free_reprobe_seconds
    return settings.llm_model_health_reprobe_seconds


def _due_models(
    models: list[str],
    recorded: Mapping[str, RecordedVerdict],
    *,
    now: datetime,
    force: bool,
) -> list[str]:
    """The subset worth spending a request on right now.

    ``free_quota_exhausted`` rows are deliberately always due: that detail is a
    statement about the day's allowance, not about the model, so the moment the
    window turns over it must be re-asked regardless of how recently it was
    written (the hold-off row is written on every sweep of the window).
    """
    if force:
        return list(models)
    due: list[str] = []
    for model_id in models:
        row = recorded.get(model_id)
        if row is None:
            due.append(model_id)
            continue
        if row.status == STATUS_THROTTLED and row.detail == "free_quota_exhausted":
            due.append(model_id)
            continue
        age = (now - row.checked_at).total_seconds() if row.checked_at else None
        if age is None or age >= _ttl_for(model_id, row.status):
            due.append(model_id)
    return due


@dataclass(frozen=True)
class ProbeBatch:
    """Outcomes for every candidate, plus which ids were never actually asked."""

    results: dict[str, ProbeOutcome]
    held: tuple[str, ...] = ()


async def probe_models(
    *,
    base_url: str,
    api_key: str,
    models: list[str],
    recorded: Mapping[str, RecordedVerdict],
    force: bool = False,
) -> ProbeBatch:
    """Ask the models worth asking; return a verdict for every candidate.

    Pure outbound: no session, no table. The caller owns persistence, which keeps
    this module testable without a database and keeps ``llm/`` off the DB (see
    ``test_arch_boundaries``). ``force`` skips the freshness filter (the manual
    "re-check" button) but never the free-pool hold — asking an empty pool again
    only spends the wait.
    """
    if not models:
        return ProbeBatch({})

    now = datetime.now(UTC)
    candidates = _due_models(models, recorded, now=now, force=force)
    free_models = [m for m in candidates if is_free_model(m)]
    paid_models = [m for m in candidates if not is_free_model(m)]

    results: dict[str, ProbeOutcome] = {}
    held: list[str] = []
    limits = httpx.Limits(max_connections=_PROBE_CONCURRENCY)
    timeout = httpx.Timeout(
        PROBE_TIMEOUT_SECONDS, connect=PROBE_CONNECT_TIMEOUT_SECONDS
    )
    async with httpx.AsyncClient(limits=limits, timeout=timeout) as client:
        if paid_models:
            semaphore = asyncio.Semaphore(_PROBE_CONCURRENCY)

            async def run(model_id: str) -> None:
                async with semaphore:
                    results[model_id] = await probe_model(
                        client, base_url=base_url, api_key=api_key, model=model_id
                    )

            await asyncio.gather(*(run(model_id) for model_id in paid_models))

        # Free ids are asked one at a time, on purpose. They share a single
        # allowance, so a concurrent burst is the fastest way to look rate
        # limited; serial probing also lets the first quota-exhausted answer stop
        # the rest of the batch instead of paying for eight more identical 429s.
        for model_id in free_models:
            if free_quota_held_off():
                held.append(model_id)
                continue
            outcome = await probe_model(
                client, base_url=base_url, api_key=api_key, model=model_id
            )
            results[model_id] = outcome
            _arm_free_quota_hold(outcome, now=datetime.now(UTC))

    # Held ids still get an answer: the allowance is per account, so "the pool is
    # empty" is the true answer for them too, and saying so beats leaving a stale
    # green tick from before the pool ran dry.
    for model_id in held:
        results[model_id] = ProbeOutcome(
            STATUS_THROTTLED, "free_quota_exhausted", None
        )
    return ProbeBatch(results, tuple(held))
