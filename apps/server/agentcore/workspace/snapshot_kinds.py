"""Snapshot kind classification (axis-3 retention + UI grouping).

Mirrors desktop ``snapshotDisplay.ts`` so prune policy and the snapshots panel
agree on what is a user pin vs system artefact.

Industry posture (Time Machine / Dropbox version history / Git reflog-ish):
rolling auto backups, named pins kept, intermediate system checkpoints capped
and aged out — except ids still referenced by open Diff / turn baselines.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal

from agentcore.storage.protocol import SnapshotRef

SnapshotKind = Literal["auto", "kept", "baseline", "system"]

# Exact labels written by desktop export / merge / preview flows.
SYSTEM_EXACT_LABELS = frozenset(
    {
        "导出",
        "导出到本地",
        "浏览器预览",
        "合回到本机",
    }
)


def classify_snapshot_label(label: str | None) -> SnapshotKind:
    """Classify one snapshot label for retention + display."""
    if not label:
        return "auto"
    if label.startswith("turn-baseline:"):
        return "baseline"
    if label.startswith("handoff:") or label in SYSTEM_EXACT_LABELS:
        return "system"
    return "kept"


def _aware(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def system_prune_ids(
    refs: list[SnapshotRef],
    *,
    baseline_max: int,
    other_max: int,
    max_age: timedelta,
    now: datetime | None = None,
    pinned_ids: set[str] | frozenset[str] | None = None,
) -> list[str]:
    """Return snapshot ids to delete under D+C (count cap ∧ TTL), newest-first ``refs``.

    User ``kept`` and unlabeled ``auto`` are ignored here (auto has its own cap).
    Within each system bucket, keep only entries that are both among the newest
    ``max`` and younger than ``max_age``; delete the rest.

    ``pinned_ids`` (open handoff Diff base / turn ``baseline_snapshot_id`` refs) are
    never returned — callers collect them by storage key before prune.
    """
    if baseline_max < 0 or other_max < 0:
        return []
    clock = _aware(now or datetime.now(UTC))
    baselines: list[SnapshotRef] = []
    others: list[SnapshotRef] = []
    for ref in refs:
        kind = classify_snapshot_label(ref.label)
        if kind == "baseline":
            baselines.append(ref)
        elif kind == "system":
            others.append(ref)

    stale: list[str] = []
    stale.extend(_bucket_prune_ids(baselines, keep=baseline_max, max_age=max_age, now=clock))
    stale.extend(_bucket_prune_ids(others, keep=other_max, max_age=max_age, now=clock))
    if not pinned_ids:
        return stale
    return [sid for sid in stale if sid not in pinned_ids]


def _bucket_prune_ids(
    refs: list[SnapshotRef],
    *,
    keep: int,
    max_age: timedelta,
    now: datetime,
) -> list[str]:
    """``refs`` must already be newest-first (caller list order)."""
    if keep <= 0:
        return [r.snapshot_id for r in refs]
    out: list[str] = []
    for i, ref in enumerate(refs):
        too_old = now - _aware(ref.created_at) > max_age
        beyond_cap = i >= keep
        if too_old or beyond_cap:
            out.append(ref.snapshot_id)
    return out
