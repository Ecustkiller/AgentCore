"""Episodic (session-summary) memory layer.

Each settled conversation writes one ≤N-char dialogue digest (plus optional verified
project-fact bullets) into the user's memory folder under ``情景/<id>.md``. Digests are
append-only, never deduped, never injected into prompts — they only feed the later
semantic consolidation pass. When turn_journal shows real tool activity, the digest
input includes a secret-redacted action inventory so verified paths/commands can land.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from agentcore.core.logging import get_logger
from agentcore.llm import LLMMessage, LLMProvider
from agentcore.llm.model_selection import build_selected_request, select_call
from agentcore.llm.provider.protocol import TokenUsage
from agentcore.memory.action_inventory import (
    TurnActionInventory,
    inventory_from_json,
    render_action_inventory_for_prompt,
)
from agentcore.memory.conversation_title import ChatMessage
from agentcore.memory.store import (
    EPISODIC_DIR,
    MEMORY_META_FILE,
    MemoryScope,
    MemoryStore,
    episodic_path,
    is_episodic_path,
)

logger = get_logger(__name__)

_FACTS_HEADING = "## 本场证实的项目事实"
_MAX_VERIFIED_FACTS_CHARS = 600


@dataclass(frozen=True)
class EpisodeRecord:
    """One undigested (or any) episodic session summary."""

    id: str
    conversation_id: str
    summary: str
    created_at: str  # ISO
    # Secret-redacted action inventory JSON (files/commands/searches); empty when absent.
    actions_json: str = ""


@dataclass
class ScopeMemoryMeta:
    """Per-(user, scope) sidecar: digested episode ids + last semantic success time.

    ``explore_workspace_key`` records the workspace identity last written by the
    cold-start explore act (过期再探); absent on legacy scopes.
    ``explore_fingerprint`` is the top-tree + key-manifest fingerprint at last explore
    close-out; ``explore_fingerprint_dirty`` is the R2 soft-stale mark (does not block).
    """

    digested_ids: set[str]
    last_semantic_at: datetime | None
    explore_workspace_key: str | None = None
    explore_fingerprint: str | None = None
    explore_fingerprint_dirty: bool = False

    def to_json(self) -> str:
        payload: dict = {
            "digested_ids": sorted(self.digested_ids),
            "last_semantic_at": (
                self.last_semantic_at.astimezone(UTC).isoformat()
                if self.last_semantic_at
                else None
            ),
        }
        if self.explore_workspace_key:
            payload["explore_workspace_key"] = self.explore_workspace_key
        if self.explore_fingerprint:
            payload["explore_fingerprint"] = self.explore_fingerprint
        if self.explore_fingerprint_dirty:
            payload["explore_fingerprint_dirty"] = True
        return json.dumps(payload, ensure_ascii=False)


def _parse_meta(raw: str) -> ScopeMemoryMeta:
    if not raw.strip():
        return ScopeMemoryMeta(digested_ids=set(), last_semantic_at=None)
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return ScopeMemoryMeta(digested_ids=set(), last_semantic_at=None)
    digested = {str(x) for x in (data.get("digested_ids") or []) if str(x).strip()}
    last_raw = data.get("last_semantic_at")
    last: datetime | None = None
    if isinstance(last_raw, str) and last_raw.strip():
        try:
            last = datetime.fromisoformat(last_raw.replace("Z", "+00:00"))
            if last.tzinfo is None:
                last = last.replace(tzinfo=UTC)
        except ValueError:
            last = None
    key_raw = data.get("explore_workspace_key")
    key = str(key_raw).strip() if isinstance(key_raw, str) and key_raw.strip() else None
    fp_raw = data.get("explore_fingerprint")
    fingerprint = (
        str(fp_raw).strip() if isinstance(fp_raw, str) and fp_raw.strip() else None
    )
    dirty = bool(data.get("explore_fingerprint_dirty"))
    return ScopeMemoryMeta(
        digested_ids=digested,
        last_semantic_at=last,
        explore_workspace_key=key,
        explore_fingerprint=fingerprint,
        explore_fingerprint_dirty=dirty,
    )


def _render_episode_body(
    *,
    conversation_id: str,
    summary: str,
    created_at: str,
    actions_json: str = "",
) -> str:
    """Markdown body with a tiny machine header; human-readable summary below."""
    header = (
        f"<!-- conversation_id: {conversation_id} -->\n"
        f"<!-- created_at: {created_at} -->\n"
    )
    if actions_json.strip():
        # Single-line comment so parsers stay simple.
        compact = " ".join(actions_json.split())
        header += f"<!-- actions: {compact} -->\n"
    return f"{header}\n{summary.strip()}\n"


def _parse_episode_body(episode_id: str, body: str) -> EpisodeRecord | None:
    conversation_id = ""
    created_at = ""
    actions_json = ""
    lines = body.splitlines()
    text_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("<!-- conversation_id:") and stripped.endswith("-->"):
            conversation_id = stripped[len("<!-- conversation_id:") : -3].strip()
            continue
        if stripped.startswith("<!-- created_at:") and stripped.endswith("-->"):
            created_at = stripped[len("<!-- created_at:") : -3].strip()
            continue
        if stripped.startswith("<!-- actions:") and stripped.endswith("-->"):
            actions_json = stripped[len("<!-- actions:") : -3].strip()
            continue
        text_lines.append(line)
    summary = "\n".join(text_lines).strip()
    if not summary:
        return None
    return EpisodeRecord(
        id=episode_id,
        conversation_id=conversation_id,
        summary=summary,
        created_at=created_at or datetime.now(UTC).isoformat(),
        actions_json=actions_json,
    )


def episode_actions(ep: EpisodeRecord) -> TurnActionInventory:
    """Parse the stored action inventory for one episode (empty if absent)."""
    return inventory_from_json(ep.actions_json)


def merge_episode_actions(episodes: Sequence[EpisodeRecord]) -> TurnActionInventory:
    """Union action inventories across undigested episodes (semantic nav gate)."""
    from agentcore.memory.action_inventory import merge_inventories

    return merge_inventories([episode_actions(ep) for ep in episodes])


def split_summary_and_facts(text: str) -> tuple[str, str]:
    """Split episodic LLM output into dialogue summary + optional verified-facts block."""
    raw = (text or "").strip()
    if not raw:
        return "", ""
    marker = _FACTS_HEADING
    idx = raw.find(marker)
    if idx < 0:
        return raw, ""
    summary = raw[:idx].strip()
    facts = raw[idx + len(marker) :].strip()
    return summary, facts


def compose_episode_summary(
    summary: str, facts: str, *, max_chars: int
) -> str:
    """Clamp the dialogue digest; keep a bounded verified-facts section when present."""
    clamped = clamp_summary(summary, max_chars)
    bullets: list[str] = []
    for ln in (facts or "").splitlines():
        item = ln.strip()
        if not item:
            continue
        item = item[2:].strip() if item.startswith("- ") else item.lstrip("- ").strip()
        if item:
            bullets.append(f"- {item}")
    if not bullets:
        return clamped
    facts_md = "\n".join(bullets)
    if len(facts_md) > _MAX_VERIFIED_FACTS_CHARS:
        facts_md = facts_md[: _MAX_VERIFIED_FACTS_CHARS - 1].rstrip() + "…"
    return f"{clamped}\n\n{_FACTS_HEADING}\n{facts_md}"


async def load_scope_meta(
    store: MemoryStore, user_id: str, *, scope: MemoryScope = None
) -> ScopeMemoryMeta:
    raw = await store.load(user_id, MEMORY_META_FILE, scope=scope)
    return _parse_meta(raw)


async def save_scope_meta(
    store: MemoryStore,
    user_id: str,
    meta: ScopeMemoryMeta,
    *,
    scope: MemoryScope = None,
) -> None:
    await store.save(user_id, MEMORY_META_FILE, meta.to_json() + "\n", scope=scope)


def clamp_summary(text: str, max_chars: int) -> str:
    """Hard-cap an episodic summary (whitespace-normalized)."""
    cleaned = " ".join(text.split()).strip()
    if max_chars <= 0 or len(cleaned) <= max_chars:
        return cleaned
    return cleaned[: max_chars - 1].rstrip() + "…"


async def append_episode(
    store: MemoryStore,
    *,
    user_id: str,
    conversation_id: str,
    summary: str,
    scope: MemoryScope = None,
    max_chars: int = 200,
    actions: TurnActionInventory | None = None,
) -> EpisodeRecord:
    """Append one session summary. Never dedups. Returns the stored record.

    ``summary`` may already include a ``## 本场证实的项目事实`` section; only the
    dialogue paragraph is hard-capped to ``max_chars``.
    """
    episode_id = uuid.uuid4().hex
    created_at = datetime.now(UTC).isoformat()
    dialogue, facts = split_summary_and_facts(summary)
    stored = compose_episode_summary(dialogue, facts, max_chars=max_chars)
    actions_json = ""
    if actions is not None and not actions.is_empty():
        actions_json = actions.to_json()
    body = _render_episode_body(
        conversation_id=conversation_id,
        summary=stored,
        created_at=created_at,
        actions_json=actions_json,
    )
    await store.save(user_id, episodic_path(episode_id), body, scope=scope)
    logger.info(
        "memory.episodic_written",
        user_id=user_id,
        conversation_id=conversation_id,
        episode_id=episode_id,
        chars=len(stored),
        scope=scope or "global",
    )
    return EpisodeRecord(
        id=episode_id,
        conversation_id=conversation_id,
        summary=stored,
        created_at=created_at,
        actions_json=actions_json,
    )


async def list_undigested_episodes(
    store: MemoryStore, user_id: str, *, scope: MemoryScope = None
) -> list[EpisodeRecord]:
    """Episodes not yet consumed by a successful semantic consolidation (oldest first)."""
    meta = await load_scope_meta(store, user_id, scope=scope)
    out: list[EpisodeRecord] = []
    for m in await store.list(user_id, scope=scope):
        if not is_episodic_path(m.path):
            continue
        episode_id = m.path[len(EPISODIC_DIR) + 1 :].removesuffix(".md")
        if episode_id in meta.digested_ids:
            continue
        body = await store.load(user_id, m.path, scope=scope)
        rec = _parse_episode_body(episode_id, body)
        if rec is not None:
            out.append(rec)
    out.sort(key=lambda r: r.created_at)
    return out


async def mark_episodes_digested(
    store: MemoryStore,
    user_id: str,
    episode_ids: list[str],
    *,
    scope: MemoryScope = None,
    consolidated_at: datetime | None = None,
) -> None:
    """Mark episodes as digested and stamp last successful semantic consolidation time."""
    if not episode_ids and consolidated_at is None:
        return
    meta = await load_scope_meta(store, user_id, scope=scope)
    meta.digested_ids.update(episode_ids)
    meta.last_semantic_at = consolidated_at or datetime.now(UTC)
    await save_scope_meta(store, user_id, meta, scope=scope)


_EPISODIC_SYSTEM = """\
Summarize this conversation for a later long-term-memory consolidation pass.

Output format (plain text, no JSON, no title):
1) ONE short paragraph in the user's language covering: what the user wanted,
   durable facts/preferences that surfaced, and any correction the user made.
   Keep the paragraph under the character budget given below.
2) OPTIONAL second block — only when the Turn action inventory lists real
   tool activity that verified project ops knowledge. Start it exactly with:

## 本场证实的项目事实

Then 1–6 short bullets. Each bullet MUST be something actually verified by the
action inventory (a real path that was read/written, a command that was run, a
search query that hit, or a pitfall observed while doing those). No speculation.
A fact is worth writing ⟺ the next session can skip one action because of it
(less re-reading / re-asking / re-failing). If the inventory is empty or nothing
meets that bar, OMIT the facts section entirely.

Omit one-off chat trivia from the paragraph. Tool noise belongs ONLY in the
verified-facts section (and only when verified).

Preference / habit rule (strict):
- User preferences and work habits may ONLY come from the user's explicit statements
  or corrections (e.g. "请用中文", "以后别用表格", "我说的是 pnpm 不是 npm").
- Do NOT infer preferences from the task topic, request genre, or one-off ask shape
  (e.g. asking for a mock trial / legal debate / multi-lens research does NOT mean
  "用户偏好法律分析" or "偏好法律对抗形式").
- If no explicit preference/correction appeared, omit preference wording entirely —
  summarize the request only.
"""

_EPISODIC_TIMEOUT_SECONDS = 20.0


class EpisodicSummarizer(Protocol):
    async def summarize(
        self,
        messages: Sequence[ChatMessage],
        *,
        max_chars: int,
        actions: TurnActionInventory | None = None,
    ) -> str: ...


class LLMEpisodicSummarizer:
    """Flash-model session summarizer for the episodic layer."""

    def __init__(
        self, provider: LLMProvider, *, role: str = "memory", model: str | None = None
    ) -> None:
        self._provider = provider
        from agentcore.config import settings

        self._selected = select_call(role, model or settings.platform_model)
        self.last_usage: TokenUsage = TokenUsage()
        self.last_model: str = ""

    async def summarize(
        self,
        messages: Sequence[ChatMessage],
        *,
        max_chars: int,
        actions: TurnActionInventory | None = None,
    ) -> str:
        convo = "\n".join(f"{m['role']}: {m['content']}" for m in messages)
        inv = actions or TurnActionInventory()
        actions_block = render_action_inventory_for_prompt(inv)
        user_prompt = (
            f"# Character budget (dialogue paragraph only)\n{max_chars}\n\n"
            f"# Turn action inventory (verified tool activity; already secret-redacted)\n"
            f"{actions_block}\n\n"
            f"# Conversation\n{convo}\n\n"
            "Write the session summary now."
        )
        request = build_selected_request(
            self._selected,
            [
                LLMMessage(role="system", content=_EPISODIC_SYSTEM),
                LLMMessage(role="user", content=user_prompt),
            ],
            stream=False,
        )
        try:
            response = await asyncio.wait_for(
                self._provider.complete(request), timeout=_EPISODIC_TIMEOUT_SECONDS
            )
        except TimeoutError:
            logger.warning("memory.episodic_summary_timeout")
            return ""
        self.last_usage = response.usage
        self.last_model = response.model or self._selected.model or ""
        dialogue, facts = split_summary_and_facts(response.content or "")
        # Drop "verified" facts when there was no real tool activity (anti-hallucination).
        if inv.is_empty():
            facts = ""
        return compose_episode_summary(dialogue, facts, max_chars=max_chars)


def fallback_episode_summary(
    messages: Sequence[ChatMessage], *, max_chars: int = 200
) -> str:
    """Deterministic fallback when the LLM summary is empty: first user turns, clamped."""
    bits: list[str] = []
    for m in messages:
        if m.get("role") == "user" and str(m.get("content") or "").strip():
            bits.append(str(m["content"]).strip())
        if len(bits) >= 3:
            break
    return clamp_summary(" / ".join(bits) if bits else "（本场对话暂无摘要）", max_chars)


def should_run_semantic(
    *,
    undigested_count: int,
    last_semantic_at: datetime | None,
    min_episodes: int,
    max_age_hours: float,
    now: datetime | None = None,
    oldest_undigested_at: datetime | None = None,
) -> bool:
    """True when undigested ≥ min_episodes OR age since last success ≥ max_age_hours.

    Zero undigested ⇒ False (nothing to merge). When there has never been a successful
    semantic pass, ``oldest_undigested_at`` anchors the age window so a single session
    is not consolidated immediately — it waits 24h (or hits the count threshold).
    """
    if undigested_count <= 0:
        return False
    if min_episodes > 0 and undigested_count >= min_episodes:
        return True
    if max_age_hours <= 0:
        return False
    clock = now or datetime.now(UTC)
    anchor = last_semantic_at or oldest_undigested_at
    if anchor is None:
        return False
    if anchor.tzinfo is None:
        anchor = anchor.replace(tzinfo=UTC)
    return (clock - anchor) >= timedelta(hours=max_age_hours)
