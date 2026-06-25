"""Assemble a user's long-term memory for prompt injection (记忆作用域与画像分层 §5.2).

The always-injected core spans two GLOBAL files (偏好.md + 画像.md) plus — for a conversation
bound to a project — that project's 画像.md. They are concatenated into ONE ``<rules>`` memory
body, GLOBAL first (the stable prefix that rides DeepSeek's cache), the project layer
appended after a short label so the model reads those bullets as project-scoped. On-demand
TOPIC names are merged across both scopes for the CEO's 记忆主题目录.

Both are gated by the per-user memory master switch (§1.6): off ⇒ "" / [] so zero memory
surfaces — the same privacy off-ramp as the rest of the memory system.
"""

from __future__ import annotations

from agentcore.memory.store import (
    ALWAYS_MEMORY_FILES,
    CORE_MEMORY_FILE,
    MemoryStore,
    is_topic_path,
    topic_slug,
)
from agentcore.memory.user_memory import strip_memory_chrome

# Labels the project layer inside the shared <rules> block so the model reads those bullets
# as "current project only" (a global vs project conflict resolves by wording + proximity,
# §3.2 — no hard-override structure; the user's explicit instruction still wins).
_PROJECT_MEMORY_LABEL = "（以下为「当前项目」专属记忆，仅在本项目内适用）"


async def load_injected_memory(
    store: MemoryStore, user_id: str, *, folder_id: str | None, enabled: bool
) -> str:
    """Build the combined memory body injected into this turn's ``<rules>`` (or "").

    Each file's human chrome (title + note) is stripped PER FILE before concatenation —
    stripping once over the joined text would only shed the first file's leading H1 and
    leave the others' titles as mid-prompt noise. GLOBAL preferences + profile come first
    (stable prefix), then the project profile (when the conversation is in a project).
    """
    if not enabled:
        return ""
    parts: list[str] = []
    for file in ALWAYS_MEMORY_FILES:
        body = strip_memory_chrome(await store.load(user_id, file))
        if body:
            parts.append(body)
    if folder_id:
        project_body = strip_memory_chrome(
            await store.load(user_id, CORE_MEMORY_FILE, scope=folder_id)
        )
        if project_body:
            parts.append(f"{_PROJECT_MEMORY_LABEL}\n{project_body}")
    return "\n\n".join(parts)


async def load_memory_topics(
    store: MemoryStore, user_id: str, *, folder_id: str | None, enabled: bool
) -> list[str]:
    """Merge global + project on-demand TOPIC names for the CEO's 记忆主题目录 (or []).

    Names only (not bodies) ride the prompt; the CEO pulls a note's full text on demand via
    ``consult_memory`` (which searches both scopes). De-duplicated and sorted for a stable
    prefix; a topic that exists in both scopes appears once.
    """
    if not enabled:
        return []
    names = {topic_slug(m.path) for m in await store.list(user_id) if is_topic_path(m.path)}
    if folder_id:
        names |= {
            topic_slug(m.path)
            for m in await store.list(user_id, scope=folder_id)
            if is_topic_path(m.path)
        }
    return sorted(names)
