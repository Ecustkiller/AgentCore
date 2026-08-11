/**
 * Snapshot list presentation helpers (axis-3: auto backup / kept version / system).
 *
 * System labels are written by product paths (turn baseline, handoff, export /
 * merge) — they share the same storage as user pins but should not read as
 * 「留版本」. Backend prune policy mirrors this classification
 * (`workspace/snapshot_kinds.py`: baseline max 5, other system max 10, TTL 30d).
 */

export type SnapshotKind = "kept" | "auto" | "system";

/** Exact labels written by desktop export / merge flows. */
const SYSTEM_EXACT_LABELS = new Set([
  "导出",
  "导出到本地",
  "浏览器预览",
  "合回到本机",
]);

export function isSystemSnapshotLabel(label: string): boolean {
  if (SYSTEM_EXACT_LABELS.has(label)) return true;
  if (label.startsWith("turn-baseline:")) return true;
  if (label.startsWith("handoff:")) return true;
  return false;
}

export function classifySnapshotLabel(label: string | null): SnapshotKind {
  if (!label) return "auto";
  if (isSystemSnapshotLabel(label)) return "system";
  return "kept";
}

/** Row title shown in the snapshots panel. */
export function snapshotDisplayTitle(label: string | null): string {
  if (!label) return "自动备份";
  if (label.startsWith("turn-baseline:")) return "回合开始前";
  if (label.startsWith("handoff:")) return "本机交接";
  return label;
}

/** Optional tooltip detail (raw system id) when the title is rewritten. */
export function snapshotDisplayHint(label: string | null): string | null {
  if (!label) return null;
  if (label.startsWith("turn-baseline:") || label.startsWith("handoff:")) {
    return label;
  }
  return null;
}

export function groupSnapshotsByKind<T extends { label: string | null }>(
  snaps: readonly T[],
): { kept: T[]; auto: T[]; system: T[] } {
  const kept: T[] = [];
  const auto: T[] = [];
  const system: T[] = [];
  for (const s of snaps) {
    const kind = classifySnapshotLabel(s.label);
    if (kind === "kept") kept.push(s);
    else if (kind === "auto") auto.push(s);
    else system.push(s);
  }
  return { kept, auto, system };
}
