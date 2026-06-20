"""Shared helpers for the repository layer (sentinel + SQL fragment builders).

Kept in one private module so the domain repos can share them without a circular
import. The package ``__init__`` re-exports ``_ilike_pattern`` for callers that
import it directly (e.g. global-search tests).
"""

from sqlalchemy import BigInteger, cast, func
from sqlalchemy.sql.elements import ColumnElement

# Sentinel for "field not provided" in partial updates, distinct from an explicit
# None (which clears a nullable column, e.g. unbinding a folder's local_dir).
_UNSET: object = object()


def _ilike_pattern(query: str) -> str:
    """Wrap a user query as a substring ILIKE pattern, escaping LIKE wildcards.

    The user's raw text is matched literally: ``%`` ``_`` and the escape char
    ``\\`` are neutralized so a query like ``50%`` can't turn into a match-all
    wildcard. Used by the global-search repos (ILIKE over title/content/name —
    前端技术与架构.md §9.8).
    """
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _sum_int(expr: ColumnElement) -> ColumnElement:
    """SUM(expr) coalesced to 0 (so an empty window aggregates to 0, not NULL)."""
    return func.coalesce(func.sum(expr), 0)


def _json_int(column: ColumnElement, key: str) -> ColumnElement:
    """Read a JSONB integer field as a castable BigInteger (nano-USD / tokens).

    ``->>`` yields text; a missing key is NULL, which SUM ignores — so absent
    token/cost keys simply don't contribute rather than erroring.
    """
    return cast(column[key].astext, BigInteger)
