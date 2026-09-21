"""Always-on user-rule injection (Agent记忆与知识系统 · 读侧全量注入).

``<设定>`` carries the user's own rules (``ai_maintained=false``) only. AI-maintained
notes (偏好 / 画像 / 导航 / 主题) stay on disk and are not injected. Read side injects
every always-on **user** entry in display order as one equal-authority join (no greedy
pack / keep-rank / silent drop). The write-side quota gate owns「常驻满了」.
Frontmatter is stripped before the model sees the body via the **storage-layer parser**
(``agentcore.documents.frontmatter``).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from agentcore.core.logging import get_logger
from agentcore.db.repositories import DocumentRepository
from agentcore.documents.description import maybe_schedule_description_fill
from agentcore.documents.frontmatter import (
    ApplyMode,
    FrontmatterEditError,
    FrontmatterError,
    parse_entry_frontmatter,
    set_entry_frontmatter,
    strip_entry_frontmatter,
)
from agentcore.memory.always_join import (
    ancestor_rule_bodies_by_scope,
    join_always_layers,
)
from agentcore.memory.scope_chain import (
    ancestor_scopes,
    cloud_scope_chain,
    db_scope_chain,
    own_scope_chain,
    snapshot_scope_chain,
)
from agentcore.memory.store import (
    CORE_MEMORY_FILE,
    NAVIGATION_MEMORY_FILE,
    PREFERENCES_MEMORY_FILE,
    MemoryStore,
)

if TYPE_CHECKING:
    from agentcore.memory.account_prepare_cache import AccountPrepareSnapshot

logger = get_logger(__name__)

# Layer labels inside the shared <设定> block (scope, not author).
_FOLDER_SETTINGS_LABEL = "（以下为「当前文件夹」专属设定，仅在本文件夹内适用）"
_ANCESTOR_SETTINGS_LABEL = (
    "（以下为「上层文件夹」的设定，其下所有文件夹一并适用；"
    "与更靠近当前文件夹的设定冲突时，以更近的为准）"
)

_RULE_MUTATE_ACTIONS = frozenset({"write", "read", "delete", "list"})
_MAX_RULE_NAME_CHARS = 80
_SKIP_ALWAYS_CONSULT_FILES = frozenset(
    {
        PREFERENCES_MEMORY_FILE,
        CORE_MEMORY_FILE,
        NAVIGATION_MEMORY_FILE,
    }
)


def normalize_rule_filename(raw: str) -> str | None:
    """Basename ``*.md`` for a rule document, or None when the name is not usable."""
    text = (raw or "").strip()
    if not text or text in {".", ".."} or "/" in text or "\\" in text:
        return None
    name = text if text.lower().endswith(".md") else f"{text}.md"
    if name == ".md" or len(name) > _MAX_RULE_NAME_CHARS:
        return None
    if name in _SKIP_ALWAYS_CONSULT_FILES:
        return None
    return name


def _fail(
    action: str, message: str, *, name: str = "", apply: str = ""
) -> UserRuleMutationResult:
    return UserRuleMutationResult(
        action=action,
        changed=False,
        message=message,
        name=name,
        apply=apply,
        ok=False,
    )


def _resolve_write_apply(
    *,
    apply: str | None,
    content: str,
    existing_apply: str | None,
) -> ApplyMode | FrontmatterError:
    if apply == "always":
        return "always"
    if apply == "on_demand":
        return "on_demand"
    parsed = parse_entry_frontmatter(content)
    if isinstance(parsed, FrontmatterError):
        return parsed
    if parsed.apply_present:
        return parsed.apply
    if existing_apply == "always":
        return "always"
    if existing_apply == "on_demand":
        return "on_demand"
    return "always"


def _format_rule_catalog(docs: Sequence[object]) -> str:
    if not docs:
        return "当前没有用户规则。"
    lines = ["当前用户规则："]
    for doc in docs:
        apply_mode = str(getattr(doc, "apply_mode", "") or "")
        label = "常驻" if apply_mode == "always" else "按需"
        desc = str(getattr(doc, "description", "") or "").strip()
        extra = f"  {desc}" if desc else ""
        lines.append(f"- {getattr(doc, 'name', '')}  {label}{extra}")
    return "\n".join(lines)


@dataclass(frozen=True)
class UserRuleMutationResult:
    """Shared mutate outcome for file overlay + account ``/rules/write|read|delete``."""

    action: str
    changed: bool
    message: str
    name: str = ""
    apply: str = ""
    body: str = ""
    catalog: tuple[tuple[str, str, str], ...] = ()
    content: str | None = None
    ok: bool = True


async def mutate_user_rule(
    repo: DocumentRepository,
    user_id: str,
    *,
    folder_id: str | None,
    action: str = "write",
    name: str | None = None,
    content: str | None = None,
    apply: str | None = None,
    description: str | None = None,
) -> UserRuleMutationResult:
    """Persist one named user-rule markdown (tool + account shared).

    Write-side always quota uses ``writer=ai``: net growth past the cap raises
    :class:`~agentcore.memory.always_quota.AlwaysQuotaExceededError`; shrink / list /
    read / unchanged skip the gate.
    """
    action_key = (action or "write").strip().lower() or "write"
    if action_key not in _RULE_MUTATE_ACTIONS:
        return _fail(action_key, f"不支持的 action：{action_key}。")

    if action_key == "list":
        docs = await repo.list_user_rule_docs(user_id, folder_id)
        catalog = tuple(
            (
                str(doc.name),
                str(doc.apply_mode or ""),
                str(doc.description or ""),
            )
            for doc in docs
        )
        return UserRuleMutationResult(
            action="list",
            changed=False,
            message=_format_rule_catalog(docs),
            catalog=catalog,
        )

    raw_name = (name or "").strip()
    filename = normalize_rule_filename(raw_name)
    if filename is None:
        if not raw_name:
            return _fail(
                action_key,
                "缺少 name。一个主题一篇文件，例如 回复语言.md。",
            )
        return _fail(
            action_key,
            "name 不可用。请用短文件名（如 回复语言.md），不要路径，也不要占用画像/偏好/导航。",
            name=raw_name,
        )

    if action_key == "read":
        doc = await repo.get_user_rule_doc(user_id, folder_id, filename)
        if doc is None:
            return _fail(
                "read",
                f"没有规则「{filename}」。",
                name=filename,
            )
        body = doc.content or ""
        apply_mode = str(doc.apply_mode or "")
        label = "常驻" if apply_mode == "always" else "按需"
        return UserRuleMutationResult(
            action="read",
            changed=False,
            message=f"规则「{filename}」（{label}）：\n{body}".rstrip(),
            name=filename,
            apply=apply_mode,
            body=body,
            content=body,
        )

    if action_key == "delete":
        existed = await repo.get_user_rule_doc(user_id, folder_id, filename)
        if existed is None:
            return _fail(
                "delete",
                f"没有规则「{filename}」。",
                name=filename,
            )
        apply_mode = str(existed.apply_mode or "")
        await repo.delete_user_rule_doc(user_id, folder_id, filename)
        return UserRuleMutationResult(
            action="delete",
            changed=True,
            message=f"已删除规则「{filename}」。",
            name=filename,
            apply=apply_mode,
        )

    text = (content or "").strip()
    if not text:
        return _fail("write", "缺少 content。", name=filename)

    existing = await repo.get_user_rule_doc(user_id, folder_id, filename)
    resolved = _resolve_write_apply(
        apply=apply,
        content=text,
        existing_apply=existing.apply_mode if existing is not None else None,
    )
    if isinstance(resolved, FrontmatterError):
        return _fail("write", resolved.message, name=filename)
    apply_mode = resolved
    try:
        body = set_entry_frontmatter(
            text, apply=apply_mode, description=description
        )
    except FrontmatterEditError as e:
        return _fail("write", str(e), name=filename)

    if existing is not None and (existing.content or "") == body:
        label = "常驻" if apply_mode == "always" else "按需"
        return UserRuleMutationResult(
            action="write",
            changed=False,
            message=f"规则「{filename}」没有变化（{label}）。",
            name=filename,
            apply=apply_mode,
            body=body,
            content=text,
        )

    from agentcore.memory.always_quota import (
        AlwaysQuotaExceededError,
        always_entry_chars,
        check_always_write,
        notify_always_quota_exceeded,
    )

    existing_always = existing is not None and existing.apply_mode == "always"
    new_is_always = apply_mode == "always"
    if new_is_always:
        decision = await check_always_write(
            repo,
            user_id,
            folder_id=folder_id,
            writer="ai",
            editing_existing_always=existing_always,
            exclude_id=existing.id if existing is not None else None,
            new_content=body,
            new_is_always=True,
        )
        if not decision.allowed:
            usage = decision.usage
            assert usage is not None
            quota_err = AlwaysQuotaExceededError(
                usage,
                decision.message,
                file=filename,
                scope=folder_id,
                attempted_chars=always_entry_chars(body),
            )
            await notify_always_quota_exceeded(user_id, quota_err)
            raise quota_err

    doc = await repo.upsert_user_rule_doc(
        user_id,
        folder_id,
        filename,
        text,
        apply=apply_mode,
        description=description,
    )
    maybe_schedule_description_fill(
        document_id=doc.id,
        user_id=user_id,
        kind=doc.kind,
        description=doc.description or "",
        content=doc.content or "",
    )
    label = "常驻" if apply_mode == "always" else "按需"
    return UserRuleMutationResult(
        action="write",
        changed=True,
        message=f"已写入规则「{filename}」（{label}）。",
        name=filename,
        apply=apply_mode,
        body=doc.content or body,
        content=text,
    )


def _injectable_body(raw: str) -> str | None:
    """Frontmatter-strip; ``None`` means skip this entry."""
    stripped = strip_entry_frontmatter(raw)
    if stripped is None:
        return None
    body = stripped.strip()
    return body or None


def _labeled_rule_body(name: str, content: str) -> str | None:
    """Injectable body headed by the catalog address so ``<设定>`` names the entry."""
    body = _injectable_body(content)
    if not body:
        return None
    title = (name or "").strip() or "untitled.md"
    from agentcore.memory.rule_files import rule_entry_relpath

    return f"### {rule_entry_relpath(title)}\n{body}"


@dataclass(frozen=True)
class RuleFragment:
    """One always-injected rule doc, ready to place in ``<设定>``.

    ``body`` is fully rendered (frontmatter/chrome stripped, folder-labeled when
    folder-scoped). Fragments are equal on the read side — no authority tier.
    """

    body: str


def compose_injected_rules(fragments: Sequence[RuleFragment]) -> str:
    """Join all always-on fragments in display order into one ``<设定>`` body.

    No doc/char budget, no keep-rank, no silent drop, no user/AI split — write side
    owns the quota gate; prompt wording is a single equal-authority block.
    """
    return "\n\n".join(f.body for f in fragments)


def _join_frags(**kwargs: object) -> list[RuleFragment]:
    return [
        RuleFragment(body=item.body)
        for item in join_always_layers(
            folder_settings_label=_FOLDER_SETTINGS_LABEL,
            ancestor_settings_label=_ANCESTOR_SETTINGS_LABEL,
            **kwargs,  # type: ignore[arg-type]
        )
    ]


async def _rule_bodies(repo: DocumentRepository, user_id: str, scope: str | None) -> list[str]:
    out: list[str] = []
    for doc in await repo.list_injectable_rules(user_id, scope, ai_maintained=False):
        body = _labeled_rule_body(str(getattr(doc, "name", "") or ""), doc.content)
        if body:
            out.append(body)
    return out


def _cloud_rule_bodies(payload: Mapping[str, object], key: str) -> list[str]:
    out: list[str] = []
    for doc in _iter_cloud_rule_docs(payload, key):
        body = _labeled_rule_body(
            str(doc.get("name") or ""), str(doc.get("content") or "")
        )
        if body:
            out.append(body)
    return out


def _cloud_doc_body(doc: Mapping[str, object]) -> str | None:
    return _labeled_rule_body(
        str(doc.get("name") or ""), str(doc.get("content") or "")
    )


async def _user_rule_fragments(
    repo: DocumentRepository, user_id: str, *, scope_chain: Sequence[str]
) -> list[RuleFragment]:
    """User always-rules. Same scope labels as the turn join."""
    ancestor_layers = [
        (None, await _rule_bodies(repo, user_id, scope)) for scope in ancestor_scopes(scope_chain)
    ]
    current_rules: list[str] = []
    if scope_chain:
        current_rules = await _rule_bodies(repo, user_id, scope_chain[-1])
    return _join_frags(
        global_rules=await _rule_bodies(repo, user_id, None),
        ancestor_layers=ancestor_layers,
        current_rules=current_rules,
        include_current=bool(scope_chain),
    )


def _user_rule_fragments_from_cloud(
    payload: Mapping[str, object], *, folder_id: str | None
) -> list[RuleFragment]:
    """Map ``POST /v1/account/rules/list`` into scope layers (rules only)."""
    chain = cloud_scope_chain(payload, folder_id)
    if folder_id and not chain:
        return _join_frags(global_rules=_cloud_rule_bodies(payload, "global_rules"))
    ancestors = ancestor_scopes(chain)
    if folder_id and not ancestors and _iter_cloud_rule_docs(payload, "ancestor_rules"):
        ancestor_layers: list[tuple[str | None, Sequence[str]]] = [
            (None, _cloud_rule_bodies(payload, "ancestor_rules"))
        ]
    else:
        ancestor_layers = [
            (None, rules)
            for rules in ancestor_rule_bodies_by_scope(
                _iter_cloud_rule_docs(payload, "ancestor_rules"),
                ancestors,
                body_of=_cloud_doc_body,
            )
        ]
    current_rules = _cloud_rule_bodies(payload, "project_rules") if chain else []
    return _join_frags(
        global_rules=_cloud_rule_bodies(payload, "global_rules"),
        ancestor_layers=ancestor_layers,
        current_rules=current_rules,
        include_current=bool(chain),
    )


async def assemble_injected_rules(
    store: MemoryStore,
    repo: DocumentRepository,
    user_id: str,
    *,
    folder_id: str | None,
    scope_chain: Sequence[str] | None = None,
    folder_user_id: str | None = None,
) -> str:
    """Load + compose this turn's ``<设定>`` body (user always-rules only).

    Display order is global → ancestors → current. AI-maintained notes are not
    loaded. ``store`` is unused on the read path (callers still pass the pipeline
    seam). Account-level rules stay on ``user_id``; folder layers use the desk
    owner when ``folder_user_id`` is set.

    ``scope_chain`` (outermost-first, current last) is resolved by the caller —
    omitting it injects the current folder only. Production entry:
    :func:`assemble_turn_rules`.
    """
    del store
    chain = tuple(scope_chain) if scope_chain is not None else own_scope_chain(folder_id)
    folder_actor = folder_user_id or user_id
    ancestor_layers: list[tuple[str | None, Sequence[str]]] = [
        (None, await _rule_bodies(repo, folder_actor, scope)) for scope in ancestor_scopes(chain)
    ]
    current_rules: list[str] = []
    if chain:
        current_rules = await _rule_bodies(repo, folder_actor, chain[-1])
    return compose_injected_rules(
        _join_frags(
            global_rules=await _rule_bodies(repo, user_id, None),
            ancestor_layers=ancestor_layers,
            current_rules=current_rules,
            include_current=bool(chain),
        )
    )


def _fragments_from_snapshot(
    snapshot: AccountPrepareSnapshot,
    *,
    folder_id: str | None,
) -> list[RuleFragment]:
    payload = snapshot.rules_payload
    chain = snapshot_scope_chain(snapshot, folder_id)
    raw_chain = payload.get("folder_chain") if payload else None
    if isinstance(raw_chain, list) and not raw_chain:
        chain = ()
    ancestors = ancestor_scopes(chain)
    rule_lists = ancestor_rule_bodies_by_scope(
        _iter_cloud_rule_docs(payload, "ancestor_rules"),
        ancestors,
        body_of=_cloud_doc_body,
    )
    ancestor_layers: list[tuple[str | None, Sequence[str]]] = [
        (None, rule_lists[i]) for i in range(len(ancestors))
    ]
    current_id = chain[-1] if chain else None
    current_rules = _cloud_rule_bodies(payload, "project_rules") if current_id else []
    return _join_frags(
        global_rules=_cloud_rule_bodies(payload, "global_rules"),
        ancestor_layers=ancestor_layers,
        current_rules=current_rules,
        include_current=bool(chain),
    )


async def assemble_turn_rules(
    store: MemoryStore,
    user_id: str,
    *,
    folder_id: str | None,
    folder_user_id: str | None = None,
) -> str:
    """Turn-time convenience over :func:`assemble_injected_rules` (the pipeline entry point).

    With account creds, prepare reads the process snapshot cache only (warm seeds it);
    miss → empty injection — never await cloud HTTP on the turn hot path. User-rule
    loading degrades to「no rules」on ANY error so injection can never break a turn.

    Nested folders inherit outside-in (§5.4): the ancestor chain comes from the warm
    snapshot on the ticketed path and from ``folders.rel_path`` otherwise.
    """
    from agentcore.account.credentials import get_account_credentials
    from agentcore.db.base import async_session_factory
    from agentcore.memory.account_prepare_cache import get_account_rules_memory_snapshot

    try:
        folder_actor = folder_user_id or user_id
        creds = get_account_credentials()
        if creds is not None and folder_actor == user_id:
            snap = get_account_rules_memory_snapshot(user_id, folder_id)
            if snap is None:
                return ""
            return compose_injected_rules(_fragments_from_snapshot(snap, folder_id=folder_id))
        async with async_session_factory() as session:
            chain = await db_scope_chain(folder_actor, folder_id, session=session)
            return await assemble_injected_rules(
                store,
                DocumentRepository(session),
                user_id,
                folder_id=folder_id,
                scope_chain=chain,
                folder_user_id=folder_actor,
            )
    except Exception as e:  # noqa: BLE001 - user rules must never break a turn's assembly
        logger.warning("memory.user_rules_load_failed", user_id=user_id, error=str(e))
        return ""


# --- on-demand user rules (规则目录 + consult_rule; NOT memory topics) ----------------------


@dataclass(frozen=True)
class OnDemandUserRule:
    """One entry in the「规则目录」: consult name + optional one-line summary.

    On-demand rules are constraint appendices (应遵守), listed in the consult directory.
    """

    name: str
    summary: str = ""


def rule_consult_name(doc_name: str) -> str:
    """Normalize a rule document filename to the name models pass to ``consult_rule``."""
    return doc_name.removesuffix(".md").strip()


async def _scope_on_demand_user_rules(
    repo: DocumentRepository, user_id: str, folder_id: str | None
) -> list[tuple[str, str]]:
    """``(consult_name, description)`` pairs for one scope's live on_demand user rules.

    The summary is the entry's ``description`` — written for retrieval — never its first
    content line; the repo already drops user-disputed entries.
    """
    out: list[tuple[str, str]] = []
    for doc in await repo.list_on_demand_user_rules(user_id, folder_id):
        name = rule_consult_name(doc.name)
        if not name:
            continue
        out.append((name, doc.description or ""))
    return out


def _iter_cloud_rule_docs(payload: Mapping[str, object], key: str) -> list[Mapping[str, object]]:
    """Normalize ``payload[key]`` to a list of mapping docs (skip junk)."""
    raw = payload.get(key) or []
    if not isinstance(raw, list):
        return []
    return [doc for doc in raw if isinstance(doc, Mapping)]


def _collect_cloud_on_demand(
    summaries: dict[str, str], payload: Mapping[str, object], key: str
) -> None:
    for doc in _iter_cloud_rule_docs(payload, key):
        name = rule_consult_name(str(doc.get("name") or ""))
        if not name:
            continue
        summaries.setdefault(name, str(doc.get("description") or ""))


def on_demand_user_rules_from_cloud(
    payload: Mapping[str, object], *, folder_id: str | None
) -> list[OnDemandUserRule]:
    """Map account ``/rules/list`` on_demand fields into the「规则目录」entries.

    Merge matches the local-DB path: global, then ancestors outermost-first, then the
    current folder, all via ``setdefault`` (the outer summary wins a name collision, as it
    has since the global-vs-folder split). Older clouds omitting the keys → [].
    """
    summaries: dict[str, str] = {}
    _collect_cloud_on_demand(summaries, payload, "global_on_demand_rules")
    chain = cloud_scope_chain(payload, folder_id)
    if chain:
        _collect_cloud_on_demand(summaries, payload, "ancestor_on_demand_rules")
        _collect_cloud_on_demand(summaries, payload, "project_on_demand_rules")
    return [OnDemandUserRule(name=name, summary=summaries[name]) for name in sorted(summaries)]


def lookup_on_demand_rule_body_from_cloud(
    payload: Mapping[str, object], *, folder_id: str | None, name: str
) -> str | None:
    """Nearest-layer-first body lookup on a ``/rules/list`` payload (consult_rule).

    Current folder → ancestors innermost-first → global: 近的覆盖远的, so the layer the
    user is standing in answers even when an outer folder defines the same rule name.
    """
    key = rule_consult_name(name)
    if not key:
        return None

    def _body_in(scope_key: str, *, innermost_first: bool = False) -> str | None:
        docs = _iter_cloud_rule_docs(payload, scope_key)
        # Ancestors arrive as one flat outermost-first list; reading it backwards is what
        # makes the nearest ancestor answer.
        for doc in reversed(docs) if innermost_first else docs:
            if rule_consult_name(str(doc.get("name") or "")) != key:
                continue
            body = str(doc.get("content") or "")
            return body if body.strip() else None
        return None

    if cloud_scope_chain(payload, folder_id):
        hit = _body_in("project_on_demand_rules")
        if hit is None:
            hit = _body_in("ancestor_on_demand_rules", innermost_first=True)
        if hit is not None:
            return hit
    hit = _body_in("global_on_demand_rules")
    if hit is not None:
        return hit
    return None


async def load_on_demand_user_rules(
    user_id: str, *, folder_id: str | None
) -> list[OnDemandUserRule]:
    """Merge global + the folder chain's on_demand user rules for the「规则目录」(or []).

    Degrades to [] on any error (same defensive posture as always-rule loading).
    Account-ticketed turns read the process prepare snapshot only (warm seeds it;
    miss → []); local / server turns read the document session.
    """
    from agentcore.account.credentials import get_account_credentials
    from agentcore.db.base import async_session_factory
    from agentcore.memory.account_prepare_cache import get_account_rules_memory_snapshot

    try:
        creds = get_account_credentials()
        if creds is not None:
            snap = get_account_rules_memory_snapshot(user_id, folder_id)
            if snap is None:
                return []
            return on_demand_user_rules_from_cloud(snap.rules_payload, folder_id=folder_id)
        async with async_session_factory() as session:
            repo = DocumentRepository(session)
            summaries: dict[str, str] = {}
            for name, summary in await _scope_on_demand_user_rules(repo, user_id, None):
                summaries.setdefault(name, summary)
            for scope in await db_scope_chain(user_id, folder_id, session=session):
                for name, summary in await _scope_on_demand_user_rules(repo, user_id, scope):
                    summaries.setdefault(name, summary)
            return [
                OnDemandUserRule(name=name, summary=summaries[name]) for name in sorted(summaries)
            ]
    except Exception as e:  # noqa: BLE001 - must never break turn assembly
        logger.warning("memory.on_demand_rules_load_failed", user_id=user_id, error=str(e))
        return []

