"""Assemble a user's long-term memory for prompt injection (Agent记忆与知识系统 §二).

The always-injected core spans two GLOBAL files (偏好.md + 画像.md) plus — for a conversation
bound to a project — that project's 画像.md then 导航.md. They are concatenated into ONE
``<rules>`` memory body, GLOBAL first (stable within the memory slice), the project layer
appended after a short label so the model reads those bullets as project-scoped. On-demand
TOPIC names are merged across both scopes for the CEO's 记忆主题目录.

This module owns memory *content* assembly only. Where that body sits in the system prompt
(:class:`~agentcore.runtime.context.contributor.SectionOrder`.MEMORY) and any provider
prefix-cache cost optimization is an assembly-layer concern — see ``runtime/context/``.

Both are gated by the caller-supplied ``enabled`` flag (product resolve is always
on / 定案 A): False ⇒ "" / [] so unit tests can still exercise the off path.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass

from agentcore.core.logging import get_logger
from agentcore.memory.store import (
    ALWAYS_MEMORY_FILES,
    CORE_MEMORY_FILE,
    NAVIGATION_MEMORY_FILE,
    MemoryScope,
    MemoryStore,
    is_topic_path,
    topic_slug,
)
from agentcore.memory.user_memory import (
    strip_bullet_timestamp,
    strip_memory_chrome,
    topic_summary_line,
)

logger = get_logger(__name__)

# Labels the project layer inside the shared <rules> block so the model reads those bullets
# as "current project only" (a global vs project conflict resolves by wording + proximity,
# §3.2 — no hard-override structure; the user's explicit instruction still wins).
_PROJECT_MEMORY_LABEL = "（以下为「当前项目」专属记忆，仅在本项目内适用）"
_PROJECT_NAV_LABEL = "（以下为「当前项目」导航短入口，只指路、不塞长文）"

# Appended when an always-injected memory file is capped (COST-001). Fixed text so the
# truncated body stays deterministic — same input → same output (assembly-layer prefix
# stability / cost optimization; see SectionOrder.MEMORY).
_MEMORY_TRUNCATION_NOTICE = "\n…（此记忆文件过长，已截断；建议精简）"

# Observability caps for ``memory.injection_truncated`` (one summary per injection).
_BULLET_LINE_RE = re.compile(r"^-\s+(.+)$")
_TRUNCATED_ENTRIES_MAX = 20  # max dropped bullet names listed in the summary log
_TRUNCATED_ENTRY_CHARS = 80  # per-entry preview length
_TRUNCATED_FILES_CHARS = 240  # joined truncated_files field ceiling


def _iter_dropped_entry_names(discarded: str) -> Iterator[str]:
    """Yield bullet texts that fell entirely past the char cap (audit M7 / 02-3.3)."""
    for line in discarded.splitlines():
        match = _BULLET_LINE_RE.match(line.strip())
        if not match:
            continue
        text = strip_bullet_timestamp(match.group(1).strip())
        if not text:
            continue
        if len(text) > _TRUNCATED_ENTRY_CHARS:
            text = text[: _TRUNCATED_ENTRY_CHARS - 1].rstrip() + "…"
        yield text


def _join_capped(parts: list[str], *, max_chars: int) -> str:
    """Comma-join names with a hard char ceiling (log must not flood)."""
    if not parts:
        return ""
    out: list[str] = []
    used = 0
    for part in parts:
        add = len(part) + (1 if out else 0)
        if used + add > max_chars:
            omitted = len(parts) - len(out)
            suffix = f",…+{omitted}" if omitted else ""
            room = max_chars - used - len(suffix)
            if room > 0 and not out:
                out.append(part[:room])
            return ",".join(out) + suffix
        out.append(part)
        used += add
    return ",".join(out)


def _cap_memory_body(
    body: str,
    cap: int | None,
    *,
    file: str,
    scope: str,
    truncated_files: list[str],
    truncated_entries: list[str],
) -> tuple[str, int]:
    """Deterministically cap one memory file's body to ``cap`` chars (COST-001 读侧 backstop).

    Memory rides :class:`~agentcore.runtime.context.contributor.SectionOrder`.MEMORY in the
    assembler; capping MUST be deterministic (head slice + FIXED notice → identical bytes for
    identical input) so the assembly-layer stable prefix is not needlessly busted for
    provider prefix-cache cost optimization. The write-side ``memory_section_bullet_cap``
    already bounds normal growth; this only fires on abnormal bloat. ``cap`` None/≤0 ⇒
    unbounded (no-op).

    Truncation is recorded into the caller-supplied lists (one summary log after all files —
    audit M7 / 02-3.3); this helper does not emit per-file log lines. Returns
    ``(body_or_capped, dropped_bullet_count)``; ``truncated_entries`` keeps at most
    ``_TRUNCATED_ENTRIES_MAX`` names across the whole injection.
    """
    if cap is None or cap <= 0 or len(body) <= cap:
        return body, 0
    label = file if scope == "global" else f"{file}@{scope}"
    truncated_files.append(label)
    dropped = 0
    for name in _iter_dropped_entry_names(body[cap:]):
        dropped += 1
        # Prefer unique names in the summary list (repeated bullets would burn the
        # length budget and hide the distinctive tail entries that were squeezed out).
        if name not in truncated_entries and len(truncated_entries) < _TRUNCATED_ENTRIES_MAX:
            truncated_entries.append(name)
    return body[:cap] + _MEMORY_TRUNCATION_NOTICE, dropped


def _log_injection_truncation(
    *,
    user_id: str,
    cap: int,
    truncated_files: list[str],
    truncated_entries: list[str],
    truncated_entries_total: int,
) -> None:
    """Emit one ``memory.injection_truncated`` summary (searchable fields; length-capped)."""
    if not truncated_files:
        return
    logger.warning(
        "memory.injection_truncated",
        user_id=user_id,
        cap=cap,
        truncated_files=_join_capped(truncated_files, max_chars=_TRUNCATED_FILES_CHARS),
        truncated_files_count=len(truncated_files),
        truncated_entries=_join_capped(
            truncated_entries, max_chars=_TRUNCATED_ENTRIES_MAX * _TRUNCATED_ENTRY_CHARS
        ),
        truncated_entries_count=len(truncated_entries),
        truncated_entries_total=truncated_entries_total,
        truncated_entries_omitted=max(0, truncated_entries_total - len(truncated_entries)),
    )


async def load_injected_memory(
    store: MemoryStore,
    user_id: str,
    *,
    folder_id: str | None,
    enabled: bool,
    file_char_cap: int | None = None,
) -> str:
    """Build the combined memory body injected into this turn's ``<rules>`` (or "").

    Each file's human chrome (title + note) is stripped PER FILE before concatenation —
    stripping once over the joined text would only shed the first file's leading H1 and
    leave the others' titles as mid-prompt noise. GLOBAL preferences + profile come first
    (stable prefix), then the project profile when ``folder_id`` is set.

    ``folder_id`` is the conversation's manual sidebar group (D4 方案 1,
    folder-refactor-design §8): truthy ⇒ load that group's project-layer 画像.md then
    导航.md (skip missing); NULL (bare chat) ⇒ global only. Auto-promote folders no
    longer exist post-migration.

    ``file_char_cap`` deterministically caps EACH file's body (COST-001 读侧 backstop) — see
    :func:`_cap_memory_body`; ``None`` (default) = unbounded, preserving callers/tests that
    don't pass it. When any file is capped, one ``memory.injection_truncated`` summary lists
    the truncated file labels and dropped bullet names (length-capped).
    """
    if not enabled:
        return ""
    parts: list[str] = []
    truncated_files: list[str] = []
    truncated_entries: list[str] = []
    truncated_entries_total = 0

    def _cap(body: str, *, file: str, scope: str) -> str:
        nonlocal truncated_entries_total
        capped, dropped = _cap_memory_body(
            body,
            file_char_cap,
            file=file,
            scope=scope,
            truncated_files=truncated_files,
            truncated_entries=truncated_entries,
        )
        truncated_entries_total += dropped
        return capped

    for file in ALWAYS_MEMORY_FILES:
        body = strip_memory_chrome(await store.load(user_id, file))
        if body:
            parts.append(_cap(body, file=file, scope="global"))
    if folder_id:
        project_body = strip_memory_chrome(
            await store.load(user_id, CORE_MEMORY_FILE, scope=folder_id)
        )
        if project_body:
            project_body = _cap(project_body, file=CORE_MEMORY_FILE, scope=folder_id)
            parts.append(f"{_PROJECT_MEMORY_LABEL}\n{project_body}")
        nav_body = strip_memory_chrome(
            await store.load(user_id, NAVIGATION_MEMORY_FILE, scope=folder_id)
        )
        if nav_body:
            nav_body = _cap(nav_body, file=NAVIGATION_MEMORY_FILE, scope=folder_id)
            parts.append(f"{_PROJECT_NAV_LABEL}\n{nav_body}")
    if truncated_files and file_char_cap is not None:
        _log_injection_truncation(
            user_id=user_id,
            cap=file_char_cap,
            truncated_files=truncated_files,
            truncated_entries=truncated_entries,
            truncated_entries_total=truncated_entries_total,
        )
    return "\n\n".join(parts)


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
    """
    if not enabled:
        return []
    summaries: dict[str, str] = {}
    for name, summary in await _scope_topics(store, user_id, None):
        summaries.setdefault(name, summary)
    if folder_id:
        for name, summary in await _scope_topics(store, user_id, folder_id):
            summaries.setdefault(name, summary)
    return [MemoryTopic(name=name, summary=summaries[name]) for name in sorted(summaries)]
