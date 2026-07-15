"""In-process session grant registry for W3 external read-only mounts.

Grants bind ``conversation_id → alias → ExternalMount`` (desktop ``root_id`` only;
absolute paths never leave the desktop). Cleared on revoke or conversation delete.
Not durable across server restarts — session-scoped by product design.
"""

from __future__ import annotations

import threading

from agentcore.workspace.external_mounts import ExternalMount, uniquify_alias

_lock = threading.Lock()
_grants: dict[str, dict[str, ExternalMount]] = {}


def list_grants(conversation_id: str) -> list[ExternalMount]:
    with _lock:
        return list(_grants.get(conversation_id, {}).values())


def grants_as_dict(conversation_id: str) -> dict[str, ExternalMount]:
    with _lock:
        return dict(_grants.get(conversation_id, {}))


def add_grant(
    conversation_id: str,
    *,
    root_id: str,
    label: str,
    alias_hint: str | None = None,
) -> ExternalMount:
    """Register or refresh a session grant. Same ``root_id`` updates label/alias."""
    with _lock:
        by_alias = _grants.setdefault(conversation_id, {})
        for existing in by_alias.values():
            if existing.root_id == root_id:
                # Keep alias stable on re-grant of the same root.
                updated = ExternalMount(
                    alias=existing.alias,
                    root_id=root_id,
                    label=label or existing.label,
                    abs_path=None,
                    readonly=True,
                )
                by_alias[existing.alias] = updated
                return updated
        taken = set(by_alias)
        alias = uniquify_alias(alias_hint or label, taken)
        mount = ExternalMount(
            alias=alias,
            root_id=root_id,
            label=label or alias,
            abs_path=None,
            readonly=True,
        )
        by_alias[alias] = mount
        return mount


def revoke_grant(conversation_id: str, *, alias: str | None = None, root_id: str | None = None) -> bool:
    """Revoke one grant by alias or root_id, or all when both omitted."""
    with _lock:
        by_alias = _grants.get(conversation_id)
        if not by_alias:
            return False
        if alias is None and root_id is None:
            del _grants[conversation_id]
            return True
        removed = False
        if alias and alias in by_alias:
            del by_alias[alias]
            removed = True
        if root_id:
            for a, m in list(by_alias.items()):
                if m.root_id == root_id:
                    del by_alias[a]
                    removed = True
        if not by_alias:
            _grants.pop(conversation_id, None)
        return removed


def clear_conversation(conversation_id: str) -> None:
    with _lock:
        _grants.pop(conversation_id, None)


def clear_all_for_tests() -> None:
    with _lock:
        _grants.clear()
