"""Small shared shape for「目录 + 按名取文」consult sources (上下文工程 · 扳机 A).

Third true consult source (``consult_rule``) lands this milestone → extract a *small*
:class:`Consultable` for directory listing + fetch-by-name. This is NOT a mega
``ContextProvider`` / Tool+Skill unifier; skills / memory / rules stay separate
implementations that may adopt the shape over time.

``consult_memory`` / ``consult_skill`` keep their existing behaviour; they are not
forced through this Protocol yet (待收敛 — prefer copying a third tool that fits
the shape over a behaviour-changing rewrite).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class ConsultDirectoryEntry:
    """One catalog row: consult ``name`` plus optional one-line summary."""

    name: str
    summary: str = ""


@runtime_checkable
class Consultable(Protocol):
    """Directory + fetch-by-name — the shared consult surface (not a Provider)."""

    async def list_directory(self, user_id: str) -> Sequence[ConsultDirectoryEntry]:
        """Names (+ optional summaries) the model may consult this turn."""
        ...

    async def fetch_by_name(self, user_id: str, name: str) -> str | None:
        """Full body for ``name``, or ``None`` on miss (caller soft-misses)."""
        ...
