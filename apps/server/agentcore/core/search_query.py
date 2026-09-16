"""Conversation-log search query: AND keywords, quoted phrases (Cursor-shaped).

Shared leaf so ``db`` can parse without importing ``conversation``.
"""

from __future__ import annotations

SEARCH_DEFAULT_LIMIT = 20
SEARCH_HARD_CAP = 100
SEARCH_VISIBLE_ROLES: tuple[str, ...] = ("user", "assistant")

_QUOTE_PAIRS: dict[str, str] = {
    '"': '"',
    "'": "'",
    "「": "」",
    "『": "』",
}


def parse_conversation_search_terms(query: str) -> list[str]:
    """Split ``query`` into AND terms: unquoted whitespace tokens + quoted phrases.

    Unbalanced openers stay literal. Empty / whitespace / quotes-only → no terms.
    """
    s = query or ""
    terms: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        closer = _QUOTE_PAIRS.get(ch)
        if closer is not None:
            j = s.find(closer, i + 1)
            if j < 0:
                buf.append(ch)
                i += 1
                continue
            if buf:
                terms.extend(part for part in "".join(buf).split() if part)
                buf = []
            phrase = s[i + 1 : j].strip()
            if phrase:
                terms.append(phrase)
            i = j + 1
            continue
        buf.append(ch)
        i += 1
    if buf:
        terms.extend(part for part in "".join(buf).split() if part)
    return terms


def earliest_term_in_text(text: str, terms: list[str]) -> str | None:
    """The term whose first case-insensitive hit is leftmost, or ``None``."""
    if not text or not terms:
        return None
    lower = text.lower()
    best_term: str | None = None
    best_idx: int | None = None
    for term in terms:
        needle = term.lower()
        if not needle:
            continue
        idx = lower.find(needle)
        if idx >= 0 and (best_idx is None or idx < best_idx):
            best_idx = idx
            best_term = term
    return best_term
