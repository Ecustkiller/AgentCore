"""Two-tier rule injection + cross-file budget (Agent记忆与知识系统 §二 / §5.7 跨文件预算).

The ``<rules>`` block now carries BOTH the user's own rules (``ai_maintained=false``) and the
AI-maintained long-term memory core (``ai_maintained=true``) — same carrier, distinguished by
authorship (§5.2). This module assembles that block:

- **两档措辞 (§二)**: user rules ride FIRST with authoritative wording (须遵守); AI memory rides
  after with soft wording (软性偏好, 可被覆盖). Authority is carried by the WORDING, not a
  separate structural channel.
- **跨文件预算 (§5.3 / §5.7)**: a single ``MAX_INSTRUCTION_DOCS`` / ``MAX_INSTRUCTION_CHARS``
  budget spans all always-injected rule docs, replacing the per-file memory cap. When the budget
  is tight GLOBAL docs survive first (「全局优先存活」), and within a scope the user's authoritative
  rules survive over soft AI memory.

Byte-stability: with no user rules and under budget, the composed memory body is identical to the
legacy ``load_injected_memory`` concatenation, so ``assemble_system_prompt`` takes its existing
memory-only ``<rules>`` path verbatim — keeps the memory slice deterministic for the
assembly-layer stable prefix (:class:`~agentcore.runtime.context.contributor.SectionOrder`)
and the memory-only prompt tests. The new combined path only engages once a user actually
has rules (or the budget trims), which is the new behavior this phase adds.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from agentcore.core.logging import get_logger
from agentcore.db.repositories import DocumentRepository
from agentcore.memory.injection import _PROJECT_MEMORY_LABEL, _PROJECT_NAV_LABEL
from agentcore.memory.store import (
    ALWAYS_MEMORY_FILES,
    CORE_MEMORY_FILE,
    NAVIGATION_MEMORY_FILE,
    MemoryStore,
)
from agentcore.memory.user_memory import strip_memory_chrome, topic_summary_line

logger = get_logger(__name__)

# Labels the project-layer user rules inside the shared block (mirrors the memory project label).
_USER_RULE_PROJECT_LABEL = "（以下为「当前项目」专属规则，仅在本项目内适用）"

_RULE_BULLET_RE = re.compile(r"^\s*[-*]\s+(.*)$")


_REMEMBER_ACTIONS = frozenset({"add", "replace", "forget", "list"})


def _normalize_rule(text: str) -> str:
    """Whitespace-collapsed, casefolded key for user-rule dedup."""
    return re.sub(r"\s+", " ", text).strip().casefold()


def _collapse_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _rebuild_rule_markdown(lines: Sequence[str]) -> str:
    body = "\n".join(lines).rstrip()
    return f"{body}\n" if body else ""


def _line_rule_text(line: str) -> str:
    match = _RULE_BULLET_RE.match(line)
    return match.group(1) if match else line


def _remove_matching_bullets(current_markdown: str, key: str) -> tuple[str, list[str]]:
    """Drop every line whose normalized rule text equals ``key``.

    Returns ``(md, removed_texts)``.
    """
    if not key:
        return current_markdown, []
    kept: list[str] = []
    removed: list[str] = []
    for line in current_markdown.splitlines():
        existing = _line_rule_text(line)
        if _normalize_rule(existing) == key:
            text = _collapse_ws(existing)
            if text:
                removed.append(text)
            continue
        kept.append(line)
    if not removed:
        return current_markdown, []
    return _rebuild_rule_markdown(kept), removed


@dataclass(frozen=True)
class UserRuleMutationResult:
    """Shared mutate outcome for ``remember`` tool + account ``/rules/remember``."""

    action: str
    changed: bool
    message: str
    markdown: str = ""
    removed: tuple[str, ...] = ()
    content: str | None = None

    @property
    def rules_markdown(self) -> str | None:
        """List action exposes the current rules body; others leave this unset."""
        return self.markdown if self.action == "list" else None


def append_user_rule_bullet(current_markdown: str, content: str) -> tuple[str, bool]:
    """Append ``content`` as a rule bullet with normalized dedup. Returns ``(new_md, changed)``.

    User rules are a plain bullet list with NO AI-maintained chrome (they are user-owned, §5.2).
    A normalized duplicate is a no-op — re-remembering the same rule does not grow the doc.
    """
    text = _collapse_ws(content)
    if not text:
        return current_markdown, False
    key = _normalize_rule(text)
    for line in current_markdown.splitlines():
        if _normalize_rule(_line_rule_text(line)) == key:
            return current_markdown, False
    body = current_markdown.rstrip()
    return (f"{body}\n" if body else "") + f"- {text}\n", True


def mutate_user_rule_markdown(
    current_markdown: str,
    *,
    action: str = "add",
    content: str | None = None,
    replaces: str | None = None,
) -> UserRuleMutationResult:
    """Pure user-rule mutate: ``add`` / ``replace`` / ``forget`` / ``list``.

    Matching uses :func:`_normalize_rule` (whitespace fold + casefold). ``forget`` / ``replace``
    remove *all* bullets sharing the matched key. ``replace`` with a missing old bullet appends
    only and reports that honestly (never claims「已替换」).
    """
    action_key = (action or "add").strip().lower() or "add"
    if action_key not in _REMEMBER_ACTIONS:
        return UserRuleMutationResult(
            action=action_key,
            changed=False,
            message=f"不支持的 action：{action_key}。",
            markdown=current_markdown,
        )

    if action_key == "list":
        body = current_markdown if current_markdown.strip() else ""
        message = (
            f"当前用户规则：\n{body.rstrip()}"
            if body.strip()
            else "当前暂无用户规则。"
        )
        return UserRuleMutationResult(
            action="list",
            changed=False,
            message=message,
            markdown=body,
        )

    text = _collapse_ws(content or "")
    if not text:
        return UserRuleMutationResult(
            action=action_key,
            changed=False,
            message="缺少 content。",
            markdown=current_markdown,
        )

    if action_key == "add":
        new_md, changed = append_user_rule_bullet(current_markdown, text)
        if not changed:
            return UserRuleMutationResult(
                action="add",
                changed=False,
                message="这条规则已经记过了（未重复写入）。",
                markdown=current_markdown,
                content=text,
            )
        return UserRuleMutationResult(
            action="add",
            changed=True,
            message=f"已追加规则：{text}",
            markdown=new_md,
            content=text,
        )

    if action_key == "forget":
        new_md, removed = _remove_matching_bullets(current_markdown, _normalize_rule(text))
        if not removed:
            return UserRuleMutationResult(
                action="forget",
                changed=False,
                message=f"未找到要忘掉的规则：{text}",
                markdown=current_markdown,
                content=text,
            )
        removed_label = "；".join(removed)
        return UserRuleMutationResult(
            action="forget",
            changed=True,
            message=f"已删除规则：{removed_label}",
            markdown=new_md,
            removed=tuple(removed),
            content=text,
        )

    # replace
    old_text = _collapse_ws(replaces or "")
    if not old_text:
        return UserRuleMutationResult(
            action="replace",
            changed=False,
            message="replace 需要 replaces（要替换掉的旧规则）。",
            markdown=current_markdown,
            content=text,
        )
    after_remove, removed = _remove_matching_bullets(
        current_markdown, _normalize_rule(old_text)
    )
    new_md, appended = append_user_rule_bullet(after_remove, text)
    if removed:
        removed_label = "；".join(removed)
        return UserRuleMutationResult(
            action="replace",
            changed=True,
            message=f"已替换规则：去掉「{removed_label}」，写入「{text}」",
            markdown=new_md,
            removed=tuple(removed),
            content=text,
        )
    if appended:
        return UserRuleMutationResult(
            action="replace",
            changed=True,
            message=f"未找到旧条「{old_text}」，已追加新规则：{text}",
            markdown=new_md,
            content=text,
        )
    return UserRuleMutationResult(
        action="replace",
        changed=False,
        message=f"未找到旧条「{old_text}」，且新规则已存在（未重复写入）。",
        markdown=current_markdown,
        content=text,
    )


async def append_user_rule(
    repo: DocumentRepository, user_id: str, *, folder_id: str | None, content: str
) -> bool:
    """Append a user rule to the scope's canonical user-rule doc (``remember`` directive path).

    Create-on-write; normalized dedup; returns whether anything changed. This is the「用户明确
    下指令 → 落用户规则」half of the ``remember`` split (§5.7 用户规则入口①) — a ``rule`` doc
    with ``ai_maintained=false``, so the offline consolidation never rewrites it.
    """
    result = await mutate_user_rule(
        repo, user_id, folder_id=folder_id, action="add", content=content
    )
    return result.changed


async def mutate_user_rule(
    repo: DocumentRepository,
    user_id: str,
    *,
    folder_id: str | None,
    action: str = "add",
    content: str | None = None,
    replaces: str | None = None,
) -> UserRuleMutationResult:
    """Persist a user-rule mutate for the scope's canonical rule doc (tool + account shared)."""
    doc = await repo.get_user_rules_doc(user_id, folder_id)
    current = doc.content if doc is not None else ""
    result = mutate_user_rule_markdown(
        current, action=action, content=content, replaces=replaces
    )
    if result.action == "list" or not result.changed:
        return result
    await repo.upsert_user_rules_doc(user_id, folder_id, result.markdown)
    return result


@dataclass(frozen=True)
class RuleFragment:
    """One always-injected rule doc, ready to place in ``<rules>``.

    ``scope`` is ``'global'`` or ``'project'`` (global survives budget first, §5.3);
    ``authority`` is ``'user'`` (authoritative user rule) or ``'ai'`` (soft memory);
    ``body`` is the fully-rendered text (chrome-stripped, project-labeled when project-scoped).
    """

    scope: str
    authority: str
    body: str

    @property
    def _keep_rank(self) -> tuple[int, int]:
        # Budget keep-priority: global before project, then user before AI within a scope —
        # so a tight budget drops project AI memory first and global user rules last.
        return (0 if self.scope == "global" else 1, 0 if self.authority == "user" else 1)


def compose_injected_rules(
    fragments: Sequence[RuleFragment], *, max_docs: int, max_chars: int
) -> tuple[str, str]:
    """Budget + compose rule fragments into ``(user_rules_markdown, memory_markdown)``.

    Greedily admits fragments in keep-priority order (global-first, user-before-AI) until the
    doc-count or char budget is hit — a fragment that would overflow is skipped, lower-priority
    ones still get a chance to fit. Survivors are then split by authorship and joined in DISPLAY
    order (global before project within each), so the memory body matches the legacy concatenation
    exactly when everything survives. A non-positive budget means「no limit」(admit all).
    """
    ordered = sorted(enumerate(fragments), key=lambda iv: (iv[1]._keep_rank, iv[0]))
    doc_cap = max_docs if max_docs and max_docs > 0 else None
    char_cap = max_chars if max_chars and max_chars > 0 else None
    kept: set[int] = set()
    used_chars = 0
    for idx, frag in ordered:
        if doc_cap is not None and len(kept) >= doc_cap:
            break
        length = len(frag.body)
        if char_cap is not None and used_chars + length > char_cap:
            continue
        kept.add(idx)
        used_chars += length
    # Display order = original fragment order (built global→project within each authority tier).
    user_bodies = [f.body for i, f in enumerate(fragments) if i in kept and f.authority == "user"]
    memory_bodies = [f.body for i, f in enumerate(fragments) if i in kept and f.authority == "ai"]
    return "\n\n".join(user_bodies), "\n\n".join(memory_bodies)


async def _memory_fragments(
    store: MemoryStore, user_id: str, *, folder_id: str | None
) -> list[RuleFragment]:
    """The AI-memory core as fragments, rendered exactly as the legacy memory concatenation.

    GLOBAL 偏好.md + 画像.md (in ``ALWAYS_MEMORY_FILES`` order, chrome-stripped) then — for a
    project conversation — that project's 画像.md then 导航.md (skip missing), project-labeled
    (§二 stable global prefix).
    """
    frags: list[RuleFragment] = []
    for file in ALWAYS_MEMORY_FILES:
        body = strip_memory_chrome(await store.load(user_id, file))
        if body:
            frags.append(RuleFragment(scope="global", authority="ai", body=body))
    if folder_id:
        project_body = strip_memory_chrome(
            await store.load(user_id, CORE_MEMORY_FILE, scope=folder_id)
        )
        if project_body:
            frags.append(
                RuleFragment(
                    scope="project",
                    authority="ai",
                    body=f"{_PROJECT_MEMORY_LABEL}\n{project_body}",
                )
            )
        nav_body = strip_memory_chrome(
            await store.load(user_id, NAVIGATION_MEMORY_FILE, scope=folder_id)
        )
        if nav_body:
            frags.append(
                RuleFragment(
                    scope="project",
                    authority="ai",
                    body=f"{_PROJECT_NAV_LABEL}\n{nav_body}",
                )
            )
    return frags


async def _user_rule_fragments(
    repo: DocumentRepository, user_id: str, *, folder_id: str | None
) -> list[RuleFragment]:
    """The user's own always-injected rule docs (``ai_maintained=false``) as fragments.

    GLOBAL rules first, then — for a project conversation — that project's rules, project-labeled.
    Injected verbatim (user-authored content): only surrounding whitespace is trimmed.
    """
    frags: list[RuleFragment] = []
    for doc in await repo.list_injectable_rules(user_id, None, ai_maintained=False):
        body = doc.content.strip()
        if body:
            frags.append(RuleFragment(scope="global", authority="user", body=body))
    if folder_id:
        for doc in await repo.list_injectable_rules(user_id, folder_id, ai_maintained=False):
            body = doc.content.strip()
            if body:
                frags.append(
                    RuleFragment(
                        scope="project",
                        authority="user",
                        body=f"{_USER_RULE_PROJECT_LABEL}\n{body}",
                    )
                )
    return frags


def _user_rule_fragments_from_cloud(
    payload: Mapping[str, object], *, folder_id: str | None
) -> list[RuleFragment]:
    """Map ``POST /v1/account/rules/list`` payload into injection fragments."""
    frags: list[RuleFragment] = []
    global_rules = payload.get("global_rules") or []
    if isinstance(global_rules, list):
        for doc in global_rules:
            if not isinstance(doc, Mapping):
                continue
            body = str(doc.get("content") or "").strip()
            if body:
                frags.append(RuleFragment(scope="global", authority="user", body=body))
    if folder_id:
        project_rules = payload.get("project_rules") or []
        if isinstance(project_rules, list):
            for doc in project_rules:
                if not isinstance(doc, Mapping):
                    continue
                body = str(doc.get("content") or "").strip()
                if body:
                    frags.append(
                        RuleFragment(
                            scope="project",
                            authority="user",
                            body=f"{_USER_RULE_PROJECT_LABEL}\n{body}",
                        )
                    )
    return frags


async def assemble_injected_rules(
    store: MemoryStore,
    repo: DocumentRepository,
    user_id: str,
    *,
    folder_id: str | None,
    enabled: bool,
    max_docs: int,
    max_chars: int,
) -> tuple[str, str]:
    """Load + budget + compose this turn's ``<rules>`` fragments (§二 / §5.7).

    Returns ``(user_rules_markdown, memory_markdown)`` for ``assemble_system_prompt``. AI memory
    is gated by the caller-supplied ``enabled`` flag (product resolve always on / 定案 A;
    False ⇒ no memory fragments); USER rules are the user's own authoritative instructions
    and are NOT memory, so they are injected regardless. Ordering within the fragment list
    is global→project per authorship so the budget's display order and the legacy byte
    layout line up.
    """
    fragments: list[RuleFragment] = []
    fragments.extend(await _user_rule_fragments(repo, user_id, folder_id=folder_id))
    if enabled:
        fragments.extend(await _memory_fragments(store, user_id, folder_id=folder_id))
    return compose_injected_rules(fragments, max_docs=max_docs, max_chars=max_chars)


async def assemble_turn_rules(
    store: MemoryStore,
    user_id: str,
    *,
    folder_id: str | None,
    enabled: bool,
    max_docs: int,
    max_chars: int,
) -> tuple[str, str]:
    """Turn-time convenience over :func:`assemble_injected_rules` (the pipeline entry point).

    AI memory is read through the given ``store`` (the patchable pipeline seam); user rules are
    read through account-cloud HTTP when the sidecar turn bound account creds, else a fresh
    document session. User-rule loading degrades to「no rules」on ANY error (missing DB in a
    unit test, transient / offline failure) so memory injection can never break a turn —
    matching the rest of the memory system's defensive posture. Byte-stability holds: with no
    user rules the memory body is identical to the legacy concatenation.
    """
    from agentcore.account.credentials import cloud_list_user_rules, get_account_credentials
    from agentcore.db.base import async_session_factory

    user_fragments: list[RuleFragment] = []
    try:
        creds = get_account_credentials()
        if creds is not None:
            payload = await cloud_list_user_rules(creds, folder_id=folder_id)
            user_fragments = _user_rule_fragments_from_cloud(payload, folder_id=folder_id)
        else:
            async with async_session_factory() as session:
                user_fragments = await _user_rule_fragments(
                    DocumentRepository(session), user_id, folder_id=folder_id
                )
    except Exception as e:  # noqa: BLE001 - user rules must never break a turn's assembly
        logger.warning("memory.user_rules_load_failed", user_id=user_id, error=str(e))

    fragments = list(user_fragments)
    if enabled:
        fragments.extend(await _memory_fragments(store, user_id, folder_id=folder_id))
    return compose_injected_rules(fragments, max_docs=max_docs, max_chars=max_chars)


# --- on-demand user rules (规则目录 + consult_rule; NOT memory topics) ----------------------


@dataclass(frozen=True)
class OnDemandUserRule:
    """One entry in the「规则目录」: consult name + optional one-line summary.

    Separate from :class:`~agentcore.memory.injection.MemoryTopic` — on_demand rules are
    constraint appendices (应遵守); topics are thick facts (供查阅). Do not merge the two.
    """

    name: str
    summary: str = ""


def rule_consult_name(doc_name: str) -> str:
    """Normalize a rule document filename to the name models pass to ``consult_rule``."""
    return doc_name.removesuffix(".md").strip()


async def _scope_on_demand_user_rules(
    repo: DocumentRepository, user_id: str, folder_id: str | None
) -> list[tuple[str, str]]:
    """``(consult_name, summary)`` pairs for one scope's on_demand user rules."""
    out: list[tuple[str, str]] = []
    for doc in await repo.list_on_demand_user_rules(user_id, folder_id):
        name = rule_consult_name(doc.name)
        if not name:
            continue
        out.append((name, topic_summary_line(doc.content or "")))
    return out


def _iter_cloud_rule_docs(
    payload: Mapping[str, object], key: str
) -> list[Mapping[str, object]]:
    """Normalize ``payload[key]`` to a list of mapping docs (skip junk)."""
    raw = payload.get(key) or []
    if not isinstance(raw, list):
        return []
    return [doc for doc in raw if isinstance(doc, Mapping)]


def on_demand_user_rules_from_cloud(
    payload: Mapping[str, object], *, folder_id: str | None
) -> list[OnDemandUserRule]:
    """Map account ``/rules/list`` on_demand fields into the「规则目录」entries.

    Merge matches the local-DB path: global first, then project via ``setdefault``
    (global summary wins on name collision). Older clouds omitting the keys → [].
    """
    summaries: dict[str, str] = {}
    for doc in _iter_cloud_rule_docs(payload, "global_on_demand_rules"):
        name = rule_consult_name(str(doc.get("name") or ""))
        if not name:
            continue
        summaries.setdefault(name, topic_summary_line(str(doc.get("content") or "")))
    if folder_id:
        for doc in _iter_cloud_rule_docs(payload, "project_on_demand_rules"):
            name = rule_consult_name(str(doc.get("name") or ""))
            if not name:
                continue
            summaries.setdefault(name, topic_summary_line(str(doc.get("content") or "")))
    return [
        OnDemandUserRule(name=name, summary=summaries[name]) for name in sorted(summaries)
    ]


def lookup_on_demand_rule_body_from_cloud(
    payload: Mapping[str, object], *, folder_id: str | None, name: str
) -> str | None:
    """Project-then-global body lookup on a ``/rules/list`` payload (consult_rule)."""
    key = rule_consult_name(name)
    if not key:
        return None

    def _body_in(scope_key: str) -> str | None:
        for doc in _iter_cloud_rule_docs(payload, scope_key):
            if rule_consult_name(str(doc.get("name") or "")) != key:
                continue
            body = str(doc.get("content") or "")
            return body if body.strip() else None
        return None

    if folder_id:
        hit = _body_in("project_on_demand_rules")
        if hit is not None:
            return hit
    return _body_in("global_on_demand_rules")


async def load_on_demand_user_rules(
    user_id: str, *, folder_id: str | None
) -> list[OnDemandUserRule]:
    """Merge global + project on_demand user rules for the「规则目录」(or []).

    Degrades to [] on any error (same defensive posture as always-rule loading).
    Account-cloud turns use ``POST …/account/rules/list`` on_demand fields (same
    ticket as always rules); local / server turns read the document session.
    """
    from agentcore.account.credentials import cloud_list_user_rules, get_account_credentials
    from agentcore.db.base import async_session_factory

    try:
        creds = get_account_credentials()
        if creds is not None:
            payload = await cloud_list_user_rules(creds, folder_id=folder_id)
            return on_demand_user_rules_from_cloud(payload, folder_id=folder_id)
        async with async_session_factory() as session:
            repo = DocumentRepository(session)
            summaries: dict[str, str] = {}
            for name, summary in await _scope_on_demand_user_rules(repo, user_id, None):
                summaries.setdefault(name, summary)
            if folder_id:
                for name, summary in await _scope_on_demand_user_rules(
                    repo, user_id, folder_id
                ):
                    summaries.setdefault(name, summary)
            return [
                OnDemandUserRule(name=name, summary=summaries[name])
                for name in sorted(summaries)
            ]
    except Exception as e:  # noqa: BLE001 - must never break turn assembly
        logger.warning("memory.on_demand_rules_load_failed", user_id=user_id, error=str(e))
        return []
