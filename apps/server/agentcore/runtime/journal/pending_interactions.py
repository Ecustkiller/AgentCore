"""Interactions journal fold（提问确认交互统一 P1/P3 · D5）.

独立投影：从 turn_journal / SSE 事件折出交互全量清单（pending|resolved|orphaned）。
供 ``GET …/recovery``（热路 pending 子集）+ conformance oracle（ProjectedTurn.interactions）共用——
**单一实现，不双写规则**。

8 kind：approval / delegation_authorization / escalation /
ask_user / plan_review / team_preview / question_posted。

``awaiting=ceo`` 的 escalation 不进用户可答清单（由活着的 CEO 仲裁）。
冷路（ask_user / plan_review / team_preview）的 frame 恢复仍走 ``paused_turns``；
本 fold 只负责交互卡生命周期投影。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

InteractionStatus = Literal["pending", "resolved", "orphaned"]

# kind → required event / resolved event / payload 自有 id 字段
_KIND_SPEC: dict[str, tuple[str, str | None, str]] = {
    "approval": ("approval_required", "approval_resolved", "approval_id"),
    "delegation_authorization": (
        "delegation_authorization_required",
        "delegation_authorization_resolved",
        "authorization_id",
    ),
    "escalation": ("escalation_required", "escalation_resolved", "escalation_id"),
    "ask_user": ("checkpoint_required", "checkpoint_resolved", "checkpoint_id"),
    "plan_review": ("plan_review_required", "plan_review_resolved", "checkpoint_id"),
    "team_preview": ("team_preview_required", "team_preview_resolved", "checkpoint_id"),
    "question_posted": ("question_posted", None, "ask_id"),
}

_HOT_KINDS = frozenset(
    {"approval", "delegation_authorization", "escalation"}
)

# Gate kinds that pause the turn in ProjectedTurn (hot approval/delegation + cold path).
GATE_KINDS = frozenset(
    {"approval", "ask_user", "plan_review", "team_preview", "delegation_authorization"}
)

_REQUIRED_TO_KIND = {required: kind for kind, (required, _, _) in _KIND_SPEC.items()}
_RESOLVED_TO_KIND = {
    resolved: kind
    for kind, (_, resolved, _) in _KIND_SPEC.items()
    if resolved is not None
}
_ID_FIELD_BY_REQUIRED = {
    required: id_field for _, (required, _, id_field) in _KIND_SPEC.items()
}
_ID_FIELD_BY_RESOLVED = {
    resolved: id_field
    for _, (_, resolved, id_field) in _KIND_SPEC.items()
    if resolved is not None
}


@dataclass(frozen=True, slots=True)
class InteractionRecord:
    """One interaction across its lifecycle (oracle / ProjectedTurn leaf)."""

    kind: str
    id: str
    status: InteractionStatus
    payload: dict[str, Any]
    resolution: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class PendingInteraction:
    """One hot-path interaction still awaiting user settlement (recovery API)."""

    kind: str
    id: str
    message_id: str
    payload: dict[str, Any]


@dataclass
class _Open:
    kind: str
    iid: str
    payload: dict[str, Any]
    status: InteractionStatus = "pending"
    resolution: dict[str, Any] | None = None
    order: int = 0


def fold_interactions(entries: list[dict[str, Any]]) -> list[InteractionRecord]:
    """Fold journal/SSE entries → full interaction list (insertion order of required).

    ``entries`` are ``{kind|type, payload}`` dicts. Terminal status is pending until a
    matching resolved/orphaned settles it; ``question_posted`` has no settle event and
    stays pending. ``awaiting=ceo`` escalations are omitted entirely.
    """
    by_key: dict[tuple[str, str], _Open] = {}
    order_counter = 0

    for entry in entries:
        event_kind = str(entry.get("kind") or entry.get("type") or "")
        payload = dict(entry.get("payload") or {})

        if event_kind == "interaction_orphaned":
            orphan_kind = str(payload.get("kind") or "")
            orphan_id = str(payload.get("interaction_id") or "")
            if orphan_kind and orphan_id:
                key = (orphan_kind, orphan_id)
                existing = by_key.get(key)
                if existing is not None and existing.status == "pending":
                    existing.status = "orphaned"
            continue

        if event_kind in _REQUIRED_TO_KIND:
            kind = _REQUIRED_TO_KIND[event_kind]
            id_field = _ID_FIELD_BY_REQUIRED[event_kind]
            iid = str(payload.get(id_field) or "")
            if not iid:
                continue
            if kind == "escalation" and payload.get("awaiting") == "ceo":
                continue
            key = (kind, iid)
            existing = by_key.get(key)
            if existing is not None and existing.status in ("resolved", "orphaned"):
                # Already settled — ignore duplicate required (replay safety).
                continue
            if existing is None:
                by_key[key] = _Open(
                    kind=kind,
                    iid=iid,
                    payload=payload,
                    status="pending",
                    order=order_counter,
                )
                order_counter += 1
            else:
                existing.payload = payload
                existing.status = "pending"
                existing.resolution = None
            continue

        if event_kind in _RESOLVED_TO_KIND:
            kind = _RESOLVED_TO_KIND[event_kind]
            id_field = _ID_FIELD_BY_RESOLVED[event_kind]
            iid = str(payload.get(id_field) or "")
            if not iid:
                continue
            key = (kind, iid)
            existing = by_key.get(key)
            if existing is None:
                # Resolved without a tracked required — ignore. Typical case: awaiting=ceo
                # was skipped on required (not user-answerable); CEO resolve must not invent
                # an empty user-facing card in interactions[].
                continue
            elif existing.status == "pending":
                existing.status = "resolved"
                existing.resolution = payload

    return [
        InteractionRecord(
            kind=o.kind,
            id=o.iid,
            status=o.status,
            payload=o.payload,
            resolution=o.resolution,
        )
        for o in sorted(by_key.values(), key=lambda x: x.order)
    ]


def fold_pending_interactions(
    entries: list[dict[str, Any]],
    *,
    message_id: str = "",
) -> list[PendingInteraction]:
    """Hot-path pending subset for ``GET …/recovery`` (clean API; filters fold_interactions)."""
    return [
        PendingInteraction(
            kind=rec.kind,
            id=rec.id,
            message_id=message_id,
            payload=rec.payload,
        )
        for rec in fold_interactions(entries)
        if rec.status == "pending" and rec.kind in _HOT_KINDS
    ]


def project_interaction_leaf(rec: InteractionRecord) -> dict[str, Any]:
    """InteractionRecord → camelCase ProjectedTurn.interactions[] leaf (oracle + golden)."""
    p = rec.payload
    base: dict[str, Any] = {"kind": rec.kind, "id": rec.id, "status": rec.status}

    if rec.kind == "approval":
        return {
            **base,
            "toolCallId": p.get("tool_call_id", ""),
            "toolName": p.get("tool_name", ""),
            "arguments": p.get("arguments") or {},
        }
    if rec.kind == "ask_user":
        return {
            **base,
            "question": p.get("question", ""),
            "context": p.get("context", ""),
        }
    if rec.kind == "plan_review":
        run_ids = [s.get("run_id", "") for s in (p.get("steps") or [])]
        return {**base, "runIds": run_ids}
    if rec.kind == "team_preview":
        worker_ids = [w.get("run_id", "") for w in (p.get("workers") or [])]
        return {**base, "workerIds": worker_ids}
    if rec.kind == "delegation_authorization":
        # Wire field is ``tools`` (not grantable_tools) — P3 drift fix.
        return {
            **base,
            "executionId": p.get("execution_id", ""),
            "workers": p.get("workers") or [],
            "tools": p.get("tools") or [],
        }
    if rec.kind == "escalation":
        leaf: dict[str, Any] = {
            **base,
            "runId": p.get("run_id", ""),
            "agentId": p.get("agent_id", ""),
            "question": p.get("question", ""),
            "assumption": p.get("assumption", ""),
        }
        if p.get("awaiting") in ("user", "ceo"):
            leaf["awaiting"] = p["awaiting"]
        return leaf
    if rec.kind == "question_posted":
        return {
            **base,
            "question": p.get("question", ""),
            "context": p.get("context", ""),
        }
    return base


def settlement_id_field(event_kind: str) -> str | None:
    """Map a journal/SSE event kind to its own-id payload field (D8 dedupe)."""
    if event_kind in _ID_FIELD_BY_REQUIRED:
        return _ID_FIELD_BY_REQUIRED[event_kind]
    if event_kind in _ID_FIELD_BY_RESOLVED:
        return _ID_FIELD_BY_RESOLVED[event_kind]
    if event_kind == "interaction_orphaned":
        return "interaction_id"
    return None


def settlement_dedupe_key(
    turn_id: str, event_kind: str, payload: dict[str, Any]
) -> tuple[str, str, str] | None:
    """``(turn_id, kind, id)`` for settlement dedupe, or None if not a settlement fact."""
    if event_kind.endswith("_resolved") or event_kind.endswith("_required"):
        if event_kind.startswith("delegation_authorization_"):
            interaction_kind = "delegation_authorization"
        elif event_kind.startswith("plan_review_"):
            interaction_kind = "plan_review"
        elif event_kind.startswith("team_preview_"):
            interaction_kind = "team_preview"
        elif event_kind.startswith("checkpoint_"):
            interaction_kind = "ask_user"
        elif event_kind.startswith("approval_"):
            interaction_kind = "approval"
        elif event_kind.startswith("escalation_"):
            interaction_kind = "escalation"
        elif event_kind == "question_posted":
            interaction_kind = "question_posted"
        else:
            interaction_kind = event_kind.rsplit("_", 1)[0]
    elif event_kind == "interaction_orphaned":
        interaction_kind = str(payload.get("kind") or "")
    else:
        return None

    id_field = settlement_id_field(event_kind)
    if not id_field:
        return None
    iid = str(payload.get(id_field) or "")
    if not iid or not interaction_kind:
        return None
    return (turn_id, interaction_kind, iid)
