"""Community estimated price table (read-only snapshot in-repo).

Loaded once from ``pricing_data/community_prices.json``. Matching is exact after
lowercase + optional provider-prefix strip — never fuzzy (wrong match is worse
than no match).

The snapshot is **vendor list prices in one currency** (``currency``, USD today) —
NOT the ledger's nano-CNY. Callers must carry :func:`community_currency` alongside
any number priced off this table; the product does no FX (无汇率换算), so a card
from here is displayed in its own currency.
"""

from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path

_DATA_PATH = Path(__file__).resolve().parent / "pricing_data" / "community_prices.json"

_PRICE_KEYS = ("cache_hit", "cache_miss", "output")

# The snapshot is public vendor USD list prices end-to-end (see the file's
# ``source``). Used when the JSON omits / mangles the ``currency`` field, so a
# malformed snapshot degrades to the truth about what those numbers are rather
# than silently claiming CNY (the bug that made BYOK spend read ~1/7 of real).
_DEFAULT_CURRENCY = "USD"


def _normalize_keys(model: str) -> list[str]:
    """Exact lookup keys: lowercase full id, then lowercase without first ``prefix/``."""
    key = (model or "").strip().lower()
    if not key:
        return []
    keys = [key]
    if "/" in key:
        _prefix, _, rest = key.partition("/")
        if rest and rest not in keys:
            keys.append(rest)
    return keys


def _card_from_raw(raw: dict) -> dict[str, Decimal] | None:
    try:
        card = {k: Decimal(str(raw[k])) for k in _PRICE_KEYS}
    except (KeyError, InvalidOperation, TypeError):
        return None
    if any(v < 0 for v in card.values()):
        return None
    return card


@lru_cache(maxsize=1)
def _load_payload() -> dict:
    if not _DATA_PATH.is_file():
        return {}
    try:
        payload = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


@lru_cache(maxsize=1)
def community_currency() -> str:
    """Currency every card in the snapshot is denominated in (``USD``).

    Table-wide by design: the snapshot is one vendor-list-price pull, so a
    per-model currency would be a lie waiting to drift. A card and this value
    always travel together — there is no FX anywhere in the product.
    """
    raw = str(_load_payload().get("currency") or "").strip().upper()
    return raw or _DEFAULT_CURRENCY


@lru_cache(maxsize=1)
def _load_index() -> dict[str, dict[str, Decimal]]:
    models = _load_payload().get("models")
    if not isinstance(models, dict):
        return {}
    index: dict[str, dict[str, Decimal]] = {}
    for name, raw in models.items():
        if not isinstance(name, str) or not isinstance(raw, dict):
            continue
        card = _card_from_raw(raw)
        if card is None:
            continue
        for key in _normalize_keys(name):
            index.setdefault(key, card)
    return index


def community_pricing_for(model: str) -> dict[str, Decimal] | None:
    """Exact community card for ``model``, or ``None`` when unknown."""
    index = _load_index()
    for key in _normalize_keys(model):
        card = index.get(key)
        if card is not None:
            return card
    return None


def community_prices_meta() -> dict[str, str]:
    """Snapshot metadata (``as_of`` / ``currency`` / ``source``) for diagnostics."""
    payload = _load_payload()
    if not payload:
        return {}
    return {
        "as_of": str(payload.get("as_of") or ""),
        "currency": community_currency(),
        "source": str(payload.get("source") or ""),
    }
