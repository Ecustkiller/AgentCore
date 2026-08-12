"""Memory topic directory + project-layer labels for prompt injection.

Production always-on injection is assembled by ``memory/rules_injection.py`` (read side
injects the full always pool; no per-file char cap). This module keeps:

- Project-layer labels shared with ``rules_injection`` (global vs project wording).
- On-demand TOPIC names + one-line summaries for the CEO's 记忆主题目录
  (``load_memory_topics`` / :class:`MemoryTopic`).

Both topic loading paths are gated by the caller-supplied ``enabled`` flag (product resolve
is always on / 定案 A): False ⇒ [] so unit tests can still exercise the off path.
"""

from __future__ import annotations

from dataclasses import dataclass

from agentcore.memory.store import (
    MemoryScope,
    MemoryStore,
    is_topic_path,
    topic_slug,
)
from agentcore.memory.user_memory import topic_summary_line

# Labels the project layer inside the shared <rules> block so the model reads those bullets
# as "current project only" (a global vs project conflict resolves by wording + proximity,
# §3.2 — no hard-override structure; the user's explicit instruction still wins).
_PROJECT_MEMORY_LABEL = "（以下为「当前项目」专属记忆，仅在本项目内适用）"
_PROJECT_NAV_LABEL = "（以下为「当前项目」导航短入口，只指路、不塞长文）"


@dataclass(frozen=True)
class MemoryTopic:
    """One entry in the CEO's 记忆主题目录: a consultable topic note's name + 1-line summary.

    ``name`` is the slug the CEO passes to ``consult_memory``; ``summary`` is the note's first
    substantive line (记忆系统 §1.4) to help it judge WHEN a topic is relevant — "" when the
    note is empty / chrome-only (the directory then shows just the name).
    """

    name: str
    summary: str


async def _scope_topics(
    store: MemoryStore, user_id: str, scope: MemoryScope
) -> list[tuple[str, str]]:
    """The (name, one-line summary) of every TOPIC note in one scope (记忆主题目录 fodder)."""
    out: list[tuple[str, str]] = []
    for meta in await store.list(user_id, scope=scope):
        if not is_topic_path(meta.path):
            continue
        body = await store.load(user_id, meta.path, scope=scope)
        out.append((topic_slug(meta.path), topic_summary_line(body)))
    return out


async def load_memory_topics(
    store: MemoryStore, user_id: str, *, folder_id: str | None, enabled: bool
) -> list[MemoryTopic]:
    """Merge global + project on-demand TOPIC notes for the CEO's 记忆主题目录 (or []).

    Each topic rides the prompt as its NAME plus a one-line summary (记忆系统 §1.4: the note's
    first substantive line) — enough for the model to decide WHEN to pull a note's full body
    via ``consult_memory`` (which searches both scopes); the body itself never rides the常驻
    prefix. De-duplicated by name and sorted for a stable prefix; a topic that exists in both
    scopes appears once (the GLOBAL summary wins, matching the stable-prefix layer).

    ``folder_id`` selects the manual group whose project-layer topics to merge (D4 方案 1);
    NULL ⇒ global topics only.

    Account-ticketed turns read the process prepare snapshot only (warm seeds it;
    miss → []); no ticket keeps the store / local-DB path.
    """
    if not enabled:
        return []
    from agentcore.account.credentials import get_account_credentials
    from agentcore.memory.account_prepare_cache import get_account_rules_memory_snapshot

    if get_account_credentials() is not None:
        snap = get_account_rules_memory_snapshot(user_id, folder_id)
        if snap is None:
            return []
        return list(snap.memory_topics)

    summaries: dict[str, str] = {}
    for name, summary in await _scope_topics(store, user_id, None):
        summaries.setdefault(name, summary)
    if folder_id:
        for name, summary in await _scope_topics(store, user_id, folder_id):
            summaries.setdefault(name, summary)
    return [MemoryTopic(name=name, summary=summaries[name]) for name in sorted(summaries)]
