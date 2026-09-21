"""Single source of truth for turning token usage into money (不变量 #2).

Every place that needs a cost calls :func:`calculate_cost` — there is no other
price table and no per-site arithmetic.

**There is no live FX.** User-facing money is curated **CNY**. Flash SKUs use
DeepSeek's official 中文列表价 (peak/off-peak by call time). Other models stay
国内官价直写. ``credential_source`` only routes the same number: platform/vendor
→ ``cost_total_nano`` (quota); user → ``cost_estimated_nano`` (display copy,
never quota). OpenCode Go's actual subscription spend is not this meter.

- **curated** ``_PRICING`` — 国内官价, **CNY** (glm / 豆包 / kimi vision).
- **Flash** — official DeepSeek CNY, peak/off-peak (official / Go V4.1 / retired
  V4 Flash alias / Zen-free share the meter). Admin still sums Go public USD for
  window cards.

Money is never a float. Costs are computed in :class:`~decimal.Decimal` and
returned as integer **nano-units of** ``Cost.currency`` (``1 unit = 1e9 nano``).
``NANO_PER_CNY`` names that scale for the CNY ledger / quota; the scale itself is
currency-independent, and display divides by it via :func:`nano_to_major`.

Card resolve does **not** depend on who pays:

- Curated hit → ``pricing_source=curated`` (BYOK included).
- User + no card → ``unpriced`` (0; never glm fallback).
- Platform/vendor + no card → glm-5.2 fallback + ``cost.pricing_fallback``.

Dated curated revisions log ``cost.pricing_prefix_match`` (match_kind=date_stem);
wire ``pricing_source`` stays ``curated``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from agentcore.core.logging import get_logger
from agentcore.llm.profiles import (
    DEEPSEEK_V4_FLASH,
    DEEPSEEK_V4_FLASH_FREE,
    DEEPSEEK_V41_FLASH,
    OPENCODE_GO_V41_FLASH,
)
from agentcore.llm.provider.protocol import TokenUsage

logger = get_logger(__name__)

# Call-level credential origin for pricing (replaces deployment ``billing_mode``).
# user = BYOK; platform = operator main key; vendor = doubao/kimi/zhipu extras.
CredentialSource = Literal["user", "platform", "vendor"]
PricingSource = Literal["curated", "estimated", "unpriced"]
# ISO-4217 code carried next to every amount. Not an enum on the wire (schemas
# keep ``str``) so a future table can add one without a lockstep client release.
CURRENCY_CNY = "CNY"
CURRENCY_USD = "USD"
# How a curated card was chosen (wire ``pricing_source`` stays ``curated``; this is
# for logs / tests so exact vs dated-stem is observable without expanding the enum).
CuratedMatchKind = Literal["exact", "date_stem"]
_VENDOR_PREFIXES = frozenset({"doubao", "kimi", "zhipu"})

# Trailing Volcengine / Anthropic-style date segment on model ids (…-260628 / …-20250514).
# Month/day must be calendar-plausible so bare ``-123456`` tails do not become stems.
_DATE_SUFFIX_RE = re.compile(r"^(?P<stem>.+)-(?P<ymd>\d{8}|\d{6})$")

# 1 major unit expressed in nano. The billed ledger / quota speak nano-CNY, hence
# the name; the scale is the same for every currency (a USD estimate is nano-USD).
NANO_PER_CNY = 1_000_000_000

# 豆包 (Volcengine 方舟) routed model id — keyed WITH the ``doubao/`` prefix because
# that is the exact string that reaches calculate_cost: the ProviderRouter only strips
# the prefix when *calling* the vendor, so cost accounting still sees the original id.
# Dated revisions (…-2607xx) inherit this card via :func:`curated_pricing_for` stem
# match — table keys stay exact ids (no separate family/stem rows).
DOUBAO_SEED_TURBO = "doubao/doubao-seed-2-1-turbo-260628"

# Qwen-VL-Max (通义千问视觉) — model id constant for vision reader config.
# No curated CNY card; platform path → glm-5.2 fallback, user path → unpriced.
QWEN_VL_MAX = "qwen-vl-max"

# Platform upstream reference model id (OpenAI-compatible). Constant kept for
# imports; no curated card this step (USD list withdrawn).
PLATFORM_GPT_4O = "gpt-4o"

# Platform relay catalog models (billing_mode=platform 内测中转目录, 成本配额与计费 §〇·六 F4).
PLATFORM_RELAY_GLM_52 = "glm-5.2"  # 平台默认；bigmodel.cn 人民币列表价直写
PLATFORM_RELAY_GROK_45 = "grok-4.5"  # id 常量保留；本步无 curated CNY 卡
# Vision-only on the operator relay (VISION_MODEL); curated so role=vision does not
# fall back to glm-5.2. Keep OFF PLATFORM_MODELS — not a user-selectable chat model.
PLATFORM_RELAY_KIMI_K25 = "kimi-k2.5"

# CNY per 1M tokens (F4). glm / 豆包 / kimi vision = 国内官价直写.
# gpt-4o / grok-4.5 / qwen-vl-max / retired Pro — 仍无 curated（不上架）.
# Flash：DeepSeek 中文官价，峰谷随调用时间；不进本表。
_FLASH_METER_IDS = frozenset(
    {
        DEEPSEEK_V4_FLASH,
        OPENCODE_GO_V41_FLASH,
        DEEPSEEK_V41_FLASH,
        DEEPSEEK_V4_FLASH_FREE,
        "deepseek-v4.1-flash-expires-on-0910",
    }
)
# Official DeepSeek V4.1 Flash (api-docs.deepseek.com/zh-cn/quick_start/pricing).
# Peak = Mon–Fri UTC 01:00–04:00 ∪ 06:00–10:00; weekends off-peak. Chinese
# public holidays are not encoded (those weekdays may overcharge as peak).
_FLASH_OFF_PEAK_CNY: dict[str, Decimal] = {
    "cache_hit": Decimal("0.02"),
    "cache_miss": Decimal("1"),
    "output": Decimal("4"),
}
_FLASH_PEAK_CNY: dict[str, Decimal] = {
    "cache_hit": Decimal("0.04"),
    "cache_miss": Decimal("2"),
    "output": Decimal("8"),
}
_PRICING: dict[str, dict[str, Decimal]] = {
    # 豆包 doubao-seed-2.1-turbo via 火山方舟. Volcengine 豆包1.6 统一定价,
    # tiered by INPUT length; this is the 0–32K tier (input ¥0.8/1M, output ¥8/1M).
    # No usable cache tier: generic OpenAI-compatible provider doesn't surface a
    # prompt cache split, so input is always billed as a miss (cache_hit mirrors
    # cache_miss). Source: Volcengine 豆包大模型 1.6 定价 (2025 FORCE).
    DOUBAO_SEED_TURBO: {
        "cache_hit": Decimal("0.8"),
        "cache_miss": Decimal("0.8"),
        "output": Decimal("8"),
    },
    # Platform relay default "glm-5.2" — F4 curated = 智谱开放平台（bigmodel.cn）
    # 人民币列表价直写。Source: bigmodel.cn/pricing
    # GLM-5.2：输入 ¥8/1M、缓存命中 ¥2/1M、输出 ¥28/1M。
    PLATFORM_RELAY_GLM_52: {
        "cache_hit": Decimal("2"),
        "cache_miss": Decimal("8"),
        "output": Decimal("28"),
    },
    # Platform vision (VISION_MODEL=kimi-k2.5 on tokenrhythm-class relay).
    # Effective CNY/1M from relay /models: in ¥4 / out ¥21 / cache_read ¥0.8.
    PLATFORM_RELAY_KIMI_K25: {
        "cache_hit": Decimal("0.8"),
        "cache_miss": Decimal("4"),
        "output": Decimal("21"),
    },
}

# Unknown / unset platform model falls back to glm-5.2 (has CNY curated card)
# rather than failing: a missing price must never crash a turn.
# Platform/vendor only — user path stays unpriced (0) instead.
_DEFAULT_MODEL = PLATFORM_RELAY_GLM_52

# tokens × (CNY / 1M tokens) → nano-CNY  ==  tokens × cny_per_million × 1000.
_PER_MILLION_TO_NANO = Decimal(1000)


def _plausible_ymd(ymd: str) -> bool:
    """True when ``ymd`` is 6/8 digits with month 01–12 and day 01–31."""
    if len(ymd) == 6:
        mm, dd = int(ymd[2:4]), int(ymd[4:6])
    elif len(ymd) == 8:
        mm, dd = int(ymd[4:6]), int(ymd[6:8])
    else:
        return False
    return 1 <= mm <= 12 and 1 <= dd <= 31


def _date_stem(model_id: str) -> str | None:
    """Stem of ``model_id`` if it ends with a plausible ``-YYMMDD`` / ``-YYYYMMDD``."""
    m = _DATE_SUFFIX_RE.match(model_id)
    if m is None or not _plausible_ymd(m.group("ymd")):
        return None
    stem = m.group("stem")
    return stem or None


def _build_date_stem_index(
    pricing: dict[str, dict[str, Decimal]],
) -> dict[str, tuple[dict[str, Decimal], str]]:
    """Map date-stripped stem → (card, canonical exact key).

    Only curated keys that themselves carry a date suffix contribute. Ambiguous
    stems (two dated keys, different cards) are omitted — refuse fake prices.
    """
    index: dict[str, tuple[dict[str, Decimal], str]] = {}
    ambiguous: set[str] = set()
    for key, card in pricing.items():
        stem = _date_stem(key)
        if stem is None:
            continue
        prior = index.get(stem)
        if prior is not None and prior[0] != card:
            ambiguous.add(stem)
            continue
        index[stem] = (card, key)
    for stem in ambiguous:
        index.pop(stem, None)
    return index


# Secondary index for dated revisions of curated ids (built once at import).
_DATE_STEM_INDEX = _build_date_stem_index(_PRICING)


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _flash_meter_id(model: str) -> str | None:
    key = (model or "").strip()
    return key if key in _FLASH_METER_IDS else None


def _flash_official_cny_card(at: datetime) -> dict[str, Decimal]:
    from agentcore.billing.opencode_go_public_prices import is_opencode_go_peak

    return dict(_FLASH_PEAK_CNY) if is_opencode_go_peak(at) else dict(_FLASH_OFF_PEAK_CNY)


def curated_pricing_for(
    model: str,
) -> tuple[dict[str, Decimal] | None, CuratedMatchKind | None, str | None]:
    """Curated card lookup: exact id, then date-stem of a dated curated sibling.

    Returns ``(card, match_kind, matched_key)``. No longest-family prefix — wrong
    prices are worse than unpriced (user) or default-tier fallback (platform).
    """
    key = (model or "").strip()
    if not key:
        return None, None, None
    exact = _PRICING.get(key)
    if exact is not None:
        return exact, "exact", key
    stem = _date_stem(key)
    if stem is None:
        return None, None, None
    hit = _DATE_STEM_INDEX.get(stem)
    if hit is None:
        return None, None, None
    card, matched_key = hit
    return card, "date_stem", matched_key


@dataclass(frozen=True)
class Cost:
    """A run's (or turn's) cost in integer nano-units of ``currency``.

    ``input`` is the whole input bill (cached + uncached); ``cached`` re-states
    just the cache-hit portion so the UI can show「省了多少」without re-pricing.
    ``output`` already includes reasoning tokens (reasoning is a billed subset of
    completion, not a separate line). ``total == input + output``.

    ``currency`` is the price card's own currency — curated ``CNY``. Every
    consumer that shows one of these numbers must show this alongside it.

    ``pricing_source`` records which price layer produced the numbers.
    ``credential_source`` rides along for ledger routing (user → estimated column).
    """

    input: int
    cached: int
    output: int
    total: int
    currency: str = CURRENCY_CNY
    pricing_source: PricingSource = "curated"
    credential_source: CredentialSource = "platform"


@dataclass(frozen=True)
class ResolvedCard:
    """The price card chosen for one call, with the currency it is written in.

    A bundle rather than a tuple because the currency must never get dropped on
    the way from table to ``Cost`` — that omission is exactly what made BYOK
    dollars render as yuan.
    """

    card: dict[str, Decimal] | None
    pricing_source: PricingSource
    currency: str
    used_fallback: bool = False


def _nano(tokens: int, price_per_million: Decimal) -> int:
    """Price ``tokens`` at ``price_per_million`` per 1M, as integer nano-units.

    Currency-agnostic: the card's currency rides on :class:`ResolvedCard`, and
    both scales are 1 unit = 1e9 nano.
    """
    if tokens <= 0:
        return 0
    value = Decimal(tokens) * price_per_million * _PER_MILLION_TO_NANO
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def resolve_credential_source(
    *,
    credential_source: CredentialSource | None = None,
    billing_mode: str | None = None,
    provider_name: str | None = None,
    model: str | None = None,
) -> CredentialSource:
    """Resolve call-level pricing source (never reads deployment ``billing_mode``).

    Precedence: explicit ``credential_source`` → provider name → model vendor
    prefix → legacy ``billing_mode`` alias (byok→user, else platform) → ambient
    log-context ``credential_source`` → ``platform`` (charge).
    """
    if credential_source is not None:
        return credential_source
    if provider_name in _VENDOR_PREFIXES:
        return "vendor"
    if provider_name == "user":
        return "user"
    if provider_name == "platform":
        return "platform"
    if model and "/" in model:
        prefix, _, _rest = model.partition("/")
        if prefix in _VENDOR_PREFIXES:
            return "vendor"
    if billing_mode is not None:
        return "user" if billing_mode == "byok" else "platform"
    try:
        from agentcore.core.log_context import get_log_value

        ambient = get_log_value("credential_source")
        if ambient in ("user", "platform", "vendor"):
            return ambient  # type: ignore[return-value]
    except Exception:  # noqa: BLE001 — pricing must never depend on log plumbing
        pass
    return "platform"


def resolve_price_card(
    model: str,
    *,
    credential_source: CredentialSource,
    at: datetime | None = None,
) -> ResolvedCard:
    """Resolve the price card + its currency for one call.

    Card lookup is the same for every payer. Flash uses official DeepSeek CNY
    (peak/off-peak from ``at``). Other ids use curated CNY (exact, then
    date-stem). ``credential_source`` only decides the miss path — user stays
    ``unpriced`` (never default-tier); platform/vendor fall back to glm-5.2.

    An ``unpriced`` result still names CNY so callers never have to invent a
    currency for a zero.
    """
    if _flash_meter_id(model):
        when = at if at is not None else _now_utc()
        return ResolvedCard(_flash_official_cny_card(when), "curated", CURRENCY_CNY)
    curated, match_kind, matched_key = curated_pricing_for(model)
    if curated is not None:
        if match_kind == "date_stem":
            # Keep ``pricing_source=curated`` on the wire; distinguish via log.
            logger.info(
                "cost.pricing_prefix_match",
                model=model or "(unset)",
                matched_key=matched_key,
                match_kind=match_kind,
            )
        return ResolvedCard(curated, "curated", CURRENCY_CNY)
    if credential_source == "user":
        return ResolvedCard(None, "unpriced", CURRENCY_CNY)
    return ResolvedCard(_PRICING[_DEFAULT_MODEL], "curated", CURRENCY_CNY, used_fallback=True)


def pricing_for(model: str) -> dict[str, Decimal]:
    """The price card for a model, falling back to the default (glm-5.2) tier."""
    resolved = resolve_price_card(model, credential_source="platform")
    assert resolved.card is not None
    return resolved.card


def has_curated_pricing(model: str) -> bool:
    """Whether ``model`` has an authoritative curated price card (不落 glm 回落).

    Platform catalog models MUST have one (成本配额与计费 §〇·六 F4): a default-tier
    ``cost.pricing_fallback`` on a platform-billed catalog row is a 漏配缺陷, not a
    graceful degrade. The catalog builder uses this to surface such misconfiguration.

    Dated revisions that share a curated sibling's date-stem count as curated
    (same card) so an id bump like ``…-260715`` is not flagged as 漏配.
    """
    if _flash_meter_id(model):
        return True
    card, _kind, _matched = curated_pricing_for(model)
    return card is not None


def pricing_for_model(
    model: str,
    *,
    credential_source: CredentialSource | None = None,
    billing_mode: str | None = None,
) -> dict[str, Decimal] | None:
    """Price card for ``model``, or ``None`` when user path is unpriced."""
    source = resolve_credential_source(
        credential_source=credential_source, billing_mode=billing_mode, model=model
    )
    resolved = resolve_price_card(model, credential_source=source)
    if resolved.pricing_source == "unpriced":
        return None
    return resolved.card


def reconcile_cache_miss_tokens(
    input_tokens: int,
    cache_hit_tokens: int,
    cache_miss_tokens: int,
) -> int:
    """Price-side cache-split guard: missing split ⇒ whole prompt as miss, not zero.

    ``max(input − hit, miss)`` is a no-op on the native DeepSeek path
    (``hit + miss == input``). Callers that persist ``TokenUsage`` must not use this
    to rewrite the 0/0 tripwire — only pricing and read-side projection.
    """
    return max(input_tokens - cache_hit_tokens, cache_miss_tokens)


def project_cache_miss_tokens(
    input_tokens: int,
    cache_hit_tokens: int,
    cache_miss_tokens: int,
) -> int:
    """Read-side ``UsageBreakdown`` projection of ``cache_miss``.

    Only the omitted shape (``input > 0`` and hit/miss both 0) is rewritten, with
    the same formula as :func:`reconcile_cache_miss_tokens`. DeepSeek true-zero
    (``miss == input``) is unchanged. Parse-layer ``TokenUsage`` stays 0/0 — that
    shape is the billing-fairness tripwire and must remain queryable.
    """
    if input_tokens > 0 and cache_hit_tokens == 0 and cache_miss_tokens == 0:
        return reconcile_cache_miss_tokens(input_tokens, cache_hit_tokens, cache_miss_tokens)
    return cache_miss_tokens


def calculate_cost(
    model: str,
    usage: TokenUsage,
    *,
    credential_source: CredentialSource | None = None,
    billing_mode: str | None = None,
    provider_name: str | None = None,
    at: datetime | None = None,
) -> Cost:
    """Convert a run's token usage into money — the only place this happens.

    Input is split by cache hit/miss (DeepSeek pre-splits the counts); output is
    priced whole (reasoning already included). Returns integer nano-units of
    ``Cost.currency`` — always CNY. Flash is official DeepSeek CNY (peak from
    ``at``, default now). Other curated cards are 国内官价.

    The card does not depend on who pays. Call-level ``credential_source`` only
    routes the same nano into billed vs estimated ledger columns.

    Two guards keep the bill honest when upstream usage is imperfect:

    - **Cache-split reconciliation**: pricing the input by hit/miss alone silently
      bills it as 0 whenever the cache split is absent but the prompt isn't — e.g.
      a BYOK ``base_url`` pointing at a proxy/gateway that returns standard
      OpenAI usage without DeepSeek's ``prompt_cache_{hit,miss}_tokens``, a model
      swap, or a dropped field. So the uncached count is reconciled to
      ``max(input_tokens − cache_hit, cache_miss)``: on the native DeepSeek path
      (``hit + miss == prompt``) this is a no-op, and when the split is missing
      the whole prompt is priced as a cache miss instead of vanishing.
    - **Fallback visibility** (platform/vendor only): an unknown/unset ``model``
      degrades to the glm-5.2 tier, logged as ``cost.pricing_fallback``.
      Dated revisions of a curated sibling (``…-YYMMDD``) keep that sibling's
      card and log ``cost.pricing_prefix_match`` instead of falling back.
    """
    source = resolve_credential_source(
        credential_source=credential_source,
        billing_mode=billing_mode,
        provider_name=provider_name,
        model=model,
    )
    resolved = resolve_price_card(model, credential_source=source, at=at)
    card, used_fallback = resolved.card, resolved.used_fallback
    if card is None:
        return Cost(
            input=0,
            cached=0,
            output=0,
            total=0,
            currency=resolved.currency,
            pricing_source="unpriced",
            credential_source=source,
        )

    if used_fallback and (usage.input_tokens or usage.output_tokens):
        logger.warning(
            "cost.pricing_fallback",
            model=model or "(unset)",
            fallback=_DEFAULT_MODEL,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
        )

    cache_miss_tokens = reconcile_cache_miss_tokens(
        usage.input_tokens, usage.cache_hit_tokens, usage.cache_miss_tokens
    )
    cached = _nano(usage.cache_hit_tokens, card["cache_hit"])
    uncached = _nano(cache_miss_tokens, card["cache_miss"])
    output = _nano(usage.output_tokens, card["output"])
    input_total = cached + uncached
    return Cost(
        input=input_total,
        cached=cached,
        output=output,
        total=input_total + output,
        currency=resolved.currency,
        pricing_source=resolved.pricing_source,
        credential_source=source,
    )


def cache_savings(
    model: str,
    usage: TokenUsage,
    *,
    credential_source: CredentialSource | None = None,
    billing_mode: str | None = None,
) -> int:
    """Nano-CNY saved by prefix-cache hits this run vs. paying the miss price.

    ``cache_hit_tokens × (miss_price − hit_price)`` — powers the「前缀缓存替你省了
    ¥X」彩蛋 (§七E). Zero when nothing hit the cache.
    """
    p = pricing_for_model(
        model,
        credential_source=credential_source,
        billing_mode=billing_mode,
    )
    if p is None:
        return 0
    full = _nano(usage.cache_hit_tokens, p["cache_miss"])
    paid = _nano(usage.cache_hit_tokens, p["cache_hit"])
    return max(full - paid, 0)


def nano_to_major(nano: int) -> float:
    """Convert integer nano-money to its major unit, rounded to 2 decimals.

    ``nano / NANO_PER_CNY`` — a pure scale change, **never** FX. The caller owns
    the currency: nano-CNY yields 元, nano-USD yields dollars. Wire field
    ``cny_total`` carries this value for whatever ``CostBreakdown.currency`` says.
    """
    major = Decimal(nano) / Decimal(NANO_PER_CNY)
    return float(major.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def nano_to_yuan(nano: int) -> float:
    """Convert ledger nano-CNY to 元 — the billed / quota path, which is CNY-only.

    Alias of :func:`nano_to_major` kept for the CNY-only call sites (quota copy,
    admin totals) so the currency assumption there stays legible.
    """
    return nano_to_major(nano)
