"""开工组队有限否决 — validate + prune + form=prose tighten (delegate team_preview).

Card continue may exclude run_ids and tighten write capability to ``text_only``
(``deliverable.form=prose``). Debate / non-delegate / stop ignore correction fields.
Does **not** hard-strip ``file_write`` tools.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from agentcore.core.errors import ValidationError
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import Deliverable
from agentcore.runtime.suspension import TeamPreviewSuspension, TurnSuspension

WriteCapability = Literal["text_only"]


@dataclass(frozen=True)
class WriteCapabilityOverride:
    run_id: str
    capability: WriteCapability = "text_only"


def normalize_write_capability_overrides(
    raw: Sequence[WriteCapabilityOverride | dict[str, Any]] | None,
) -> list[WriteCapabilityOverride]:
    """Coerce API / CheckpointResponse shapes into typed overrides."""
    out: list[WriteCapabilityOverride] = []
    for item in raw or []:
        if isinstance(item, WriteCapabilityOverride):
            out.append(item)
            continue
        if not isinstance(item, dict):
            raise ValidationError("write_capability_overrides 项必须是对象")
        run_id = str(item.get("run_id") or "").strip()
        capability = str(item.get("capability") or "").strip()
        if not run_id:
            raise ValidationError("write_capability_overrides.run_id 不能为空")
        if capability != "text_only":
            # 升权或未知 capability — 卡上仅允许收紧为 text_only。
            raise ValidationError(
                "write_capability_overrides.capability 仅允许 text_only（不可升权）"
            )
        out.append(WriteCapabilityOverride(run_id=run_id, capability="text_only"))
    return out


def should_apply_team_veto(
    suspension: TurnSuspension | Any,
    decision: CheckpointDecision | str,
) -> bool:
    """True only for delegate ``team_preview`` + ``continue`` (corrections apply)."""
    if not isinstance(suspension, TeamPreviewSuspension):
        return False
    if getattr(suspension, "primitive", "delegate") != "delegate":
        return False
    value = decision.value if isinstance(decision, CheckpointDecision) else str(decision)
    return value == CheckpointDecision.CONTINUE.value


def validate_team_preview_veto(
    plan: RunPlan,
    *,
    excluded_run_ids: Sequence[str] | None = None,
    write_capability_overrides: Sequence[WriteCapabilityOverride | dict[str, Any]]
    | None = None,
) -> None:
    """Raise ``ValidationError`` (HTTP 422) when corrections are illegal."""
    nodes = [
        {
            "run_id": n.run_id,
            "depends_on": list(n.depends_on or []),
        }
        for n in plan.nodes
    ]
    validate_team_preview_veto_workers(
        nodes,
        excluded_run_ids=excluded_run_ids,
        write_capability_overrides=write_capability_overrides,
    )


def validate_team_preview_veto_workers(
    workers: Sequence[dict[str, Any]],
    *,
    excluded_run_ids: Sequence[str] | None = None,
    write_capability_overrides: Sequence[WriteCapabilityOverride | dict[str, Any]]
    | None = None,
) -> None:
    """Validate corrections against kickoff card ``workers`` (cold peek has no plan blob)."""
    excluded = [str(x).strip() for x in (excluded_run_ids or []) if str(x).strip()]
    overrides = normalize_write_capability_overrides(write_capability_overrides)
    plan_ids = {
        str(w.get("run_id") or "").strip()
        for w in workers
        if isinstance(w, dict) and str(w.get("run_id") or "").strip()
    }

    unknown_excluded = sorted({rid for rid in excluded if rid not in plan_ids})
    if unknown_excluded:
        raise ValidationError(f"excluded_run_ids 含未知 run_id: {', '.join(unknown_excluded)}")

    override_ids = [o.run_id for o in overrides]
    unknown_overrides = sorted({rid for rid in override_ids if rid not in plan_ids})
    if unknown_overrides:
        raise ValidationError(
            f"write_capability_overrides 含未知 run_id: {', '.join(unknown_overrides)}"
        )

    excluded_set = set(excluded)
    remaining = [rid for rid in plan_ids if rid not in excluded_set]
    # 空 workers + 无修正 = 冷 peek 无 plan blob 时的 no-op；有排除才要求 ≥1。
    if excluded_set and not remaining:
        raise ValidationError("排除后须至少保留一名队员")
    if not plan_ids:
        return

    for w in workers:
        if not isinstance(w, dict):
            continue
        rid = str(w.get("run_id") or "").strip()
        if not rid or rid in excluded_set:
            continue
        deps = w.get("depends_on") or []
        if not isinstance(deps, list):
            continue
        for dep in deps:
            if str(dep).strip() in excluded_set:
                raise ValidationError("仍有队员依赖此岗，无法排除")


def apply_team_preview_veto(
    plan: RunPlan,
    *,
    excluded_run_ids: Sequence[str] | None = None,
    write_capability_overrides: Sequence[WriteCapabilityOverride | dict[str, Any]]
    | None = None,
    seed_completed: dict[str, Any] | None = None,
) -> tuple[list[str], list[WriteCapabilityOverride]]:
    """Prune excluded nodes + set ``form=prose`` for overrides (in place).

    Caller must have validated (or call :func:`validate_team_preview_veto` first).
    Returns the applied excluded ids + overrides for resolved 对账.
    """
    excluded = [str(x).strip() for x in (excluded_run_ids or []) if str(x).strip()]
    overrides = normalize_write_capability_overrides(write_capability_overrides)
    excluded_set = set(excluded)

    if excluded_set:
        plan.nodes = [n for n in plan.nodes if n.run_id not in excluded_set]
        if seed_completed is not None:
            for rid in excluded_set:
                seed_completed.pop(rid, None)

    for item in overrides:
        if item.run_id in excluded_set:
            continue
        node = plan.by_id(item.run_id)
        if node is None:
            continue
        if node.deliverable is None:
            node.deliverable = Deliverable(form="prose")
        else:
            node.deliverable.form = "prose"

    applied_excluded = [rid for rid in excluded if rid]
    return applied_excluded, overrides


def veto_summary_for_resolved(
    *,
    excluded_run_ids: Sequence[str] | None,
    write_capability_overrides: Sequence[WriteCapabilityOverride | dict[str, Any]]
    | None,
) -> tuple[list[str], list[dict[str, str]]]:
    """Wire-shaped correction summary (empty → omit from payload)."""
    excluded = [str(x).strip() for x in (excluded_run_ids or []) if str(x).strip()]
    overrides = normalize_write_capability_overrides(write_capability_overrides)
    override_rows = [{"run_id": o.run_id, "capability": o.capability} for o in overrides]
    return excluded, override_rows
