"""Clone-conversation titles: ``报告`` → ``报告 (1)`` / ``报告 (2)``.

Conversation titles are not unique; this only picks a free display number among
the caller's live chats so the sidebar can tell forks apart. The original row
keeps its title. Folder uniqueness (``unique_sibling_name``, first collision
``(2)``) is a different rule — the unsuffixed name is already taken on disk.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

# Matches ``Conversation.title`` ``String(500)``.
CONVERSATION_TITLE_MAX_LEN = 500

FORK_UNTITLED_STEM = "新对话"

# Old clone suffix (``报告 副本`` / stacked ``副本 副本`` / file-style ``副本 2``),
# including a title that is only that suffix.
_LEGACY_COPY_SUFFIX = re.compile(r"(?:(?:^| )副本(?: \d+)?)+$")
# One fork index we minted (1–3 digits). Four-digit tails like ``(2022)`` stay.
_FORK_INDEX_SUFFIX = re.compile(r" \((\d{1,3})\)$")


def fork_stem(title: str) -> str:
    """Base label after peeling a legacy「副本」tail and/or one `` (n)`` index."""
    text = (title or "").strip()
    while True:
        nxt = _LEGACY_COPY_SUFFIX.sub("", text)
        nxt = _FORK_INDEX_SUFFIX.sub("", nxt).strip()
        if nxt == text:
            return text
        text = nxt


def next_fork_title(
    source_title: str,
    existing: Iterable[str],
    *,
    max_len: int = CONVERSATION_TITLE_MAX_LEN,
) -> str:
    """Next free ``{stem} (n)`` among ``existing`` (casefold; n starts at 1)."""
    stem = fork_stem(source_title) or FORK_UNTITLED_STEM
    used = {t.casefold() for t in existing if t and str(t).strip()}
    n = 1
    while True:
        suffix = f" ({n})"
        room = max_len - len(suffix)
        if room < 1:
            return stem[:max_len]
        head = stem if len(stem) <= room else stem[:room]
        candidate = f"{head}{suffix}"
        if candidate.casefold() not in used:
            return candidate
        n += 1
