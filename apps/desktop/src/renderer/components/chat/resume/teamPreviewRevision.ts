import {
  TEAM_PRIMITIVE_META,
  fillTeamRevisionTemplate,
} from "@/components/chat/decision";
import type { KickoffPrimitive } from "@/stores/conversation";
import type { PendingResume } from "@/stores/pausedTurns";

/** 意见原文超过此长度（或含换行）默认两行截断，可展开。 */
export const REVISION_NOTE_CLAMP_CHARS = 60;

export type TeamPreviewRevisionSnapshot = {
  primitive: KickoffPrimitive;
  workers: TeamPreviewRevisionWorker[];
  motion: string;
  sides: TeamPreviewRevisionSide[];
};

export type TeamPreviewRevisionWorker = {
  run_id: string;
  role: string;
  task: string;
  depends_on: string[];
  write_capability?: "text_only" | "can_write_files";
};

export type TeamPreviewRevisionSide = {
  key: string;
  name: string;
  stance: string;
};

export type TeamPreviewRevisionDiff = {
  /** unavailable = 上一版 payload 找不到或无法对拍；禁止画空「无变化」。 */
  status: "unavailable" | "ready";
  lines: string[];
};

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function writeCap(v: unknown): "text_only" | "can_write_files" | undefined {
  return v === "text_only" || v === "can_write_files" ? v : undefined;
}

function parseWorkers(raw: unknown): TeamPreviewRevisionWorker[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const w = asRecord(row) ?? {};
    const cap = writeCap(w.write_capability);
    return {
      run_id: str(w.run_id),
      role: str(w.role),
      task: str(w.task),
      depends_on: Array.isArray(w.depends_on) ? w.depends_on.map(String) : [],
      ...(cap ? { write_capability: cap } : {}),
    };
  });
}

function parseSides(raw: unknown): TeamPreviewRevisionSide[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const s = asRecord(row) ?? {};
    return {
      key: str(s.key),
      name: str(s.name),
      stance: str(s.stance),
    };
  });
}

/**
 * 上一版 `team_preview_required` payload。空 stub / 无编制形状 → null（按缺失处理）。
 */
export function snapshotFromPayload(
  payload: Record<string, unknown> | null | undefined,
): TeamPreviewRevisionSnapshot | null {
  if (!payload) return null;
  const hasShape =
    Array.isArray(payload.workers) ||
    Array.isArray(payload.sides) ||
    typeof payload.motion === "string" ||
    typeof payload.primitive === "string";
  if (!hasShape) return null;
  return {
    primitive: payload.primitive === "debate" ? "debate" : "delegate",
    workers: parseWorkers(payload.workers),
    motion: str(payload.motion),
    sides: parseSides(payload.sides),
  };
}

export function snapshotFromResume(
  turn: Pick<PendingResume, "primitive" | "workers" | "motion" | "sides">,
): TeamPreviewRevisionSnapshot {
  return {
    primitive: turn.primitive,
    workers: turn.workers.map((w) => ({
      run_id: w.run_id,
      role: w.role,
      task: w.task,
      depends_on: w.depends_on ?? [],
      ...(w.write_capability ? { write_capability: w.write_capability } : {}),
    })),
    motion: turn.motion ?? "",
    sides: turn.sides.map((s) => ({
      key: s.key,
      name: s.name,
      stance: s.stance,
    })),
  };
}

export function lookupPreviousTeamPreviewPayload(
  revisedFrom: string | undefined,
  byId: ReadonlyMap<
    string,
    { kind?: string; payload?: Record<string, unknown> }
  >,
): Record<string, unknown> | null {
  const id = revisedFrom?.trim();
  if (!id) return null;
  const entry = byId.get(id);
  if (!entry || entry.kind !== "team_preview") return null;
  const payload = entry.payload;
  if (!payload || Object.keys(payload).length === 0) return null;
  return payload;
}

function countBy<T>(list: T[], key: (item: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of list) {
    const k = key(item);
    if (!k) continue;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

function matchByIdThenUniqueKey<T extends { id: string; matchKey: string }>(
  prev: T[],
  next: T[],
): { pairs: Array<{ prev: T; next: T }>; added: T[]; removed: T[] } {
  const usedPrev = new Set<T>();
  const usedNext = new Set<T>();
  const pairs: Array<{ prev: T; next: T }> = [];
  const prevById = new Map<string, T>();
  for (const p of prev) {
    if (p.id) prevById.set(p.id, p);
  }
  for (const n of next) {
    if (!n.id) continue;
    const p = prevById.get(n.id);
    if (!p || usedPrev.has(p)) continue;
    pairs.push({ prev: p, next: n });
    usedPrev.add(p);
    usedNext.add(n);
  }
  const remPrev = prev.filter((p) => !usedPrev.has(p));
  const remNext = next.filter((n) => !usedNext.has(n));
  const prevKeyCount = countBy(remPrev, (p) => p.matchKey);
  const nextKeyCount = countBy(remNext, (n) => n.matchKey);
  for (const n of remNext) {
    if (!n.matchKey) continue;
    if (nextKeyCount.get(n.matchKey) !== 1) continue;
    if (prevKeyCount.get(n.matchKey) !== 1) continue;
    const p = remPrev.find(
      (row) => row.matchKey === n.matchKey && !usedPrev.has(row),
    );
    if (!p) continue;
    pairs.push({ prev: p, next: n });
    usedPrev.add(p);
    usedNext.add(n);
  }
  return {
    pairs,
    added: next.filter((n) => !usedNext.has(n)),
    removed: prev.filter((p) => !usedPrev.has(p)),
  };
}

function depKeys(deps: string[], canonical: Map<string, string>): Set<string> {
  const keys = new Set<string>();
  for (const id of deps) {
    keys.add(canonical.get(id) ?? `unknown:${id}`);
  }
  return keys;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) {
    if (!b.has(k)) return false;
  }
  return true;
}

function displayName(primitive: KickoffPrimitive, name: string): string {
  const trimmed = name.trim();
  return trimmed || TEAM_PRIMITIVE_META[primitive].revision.unnamed;
}

function delegateLines(
  previous: TeamPreviewRevisionSnapshot,
  current: TeamPreviewRevisionSnapshot,
): string[] {
  const copy = TEAM_PRIMITIVE_META.delegate.revision;
  const prevRows = previous.workers.map((w) => ({
    ...w,
    id: w.run_id,
    matchKey: w.role.trim(),
  }));
  const nextRows = current.workers.map((w) => ({
    ...w,
    id: w.run_id,
    matchKey: w.role.trim(),
  }));
  const { pairs, added, removed } = matchByIdThenUniqueKey(prevRows, nextRows);
  const canonical = new Map<string, string>();
  for (const { prev, next } of pairs) {
    const key = `pair:${next.run_id || prev.run_id}`;
    if (prev.run_id) canonical.set(prev.run_id, key);
    if (next.run_id) canonical.set(next.run_id, key);
  }
  for (const w of [...removed, ...added]) {
    if (w.run_id) canonical.set(w.run_id, `solo:${w.run_id}`);
  }
  const lines: string[] = [];
  for (const w of removed) {
    lines.push(
      fillTeamRevisionTemplate(copy.removed, {
        name: displayName("delegate", w.role),
      }),
    );
  }
  for (const w of added) {
    lines.push(
      fillTeamRevisionTemplate(copy.added, {
        name: displayName("delegate", w.role),
      }),
    );
  }
  for (const { prev, next } of pairs) {
    const name = displayName("delegate", next.role || prev.role);
    if (
      prev.role.trim() !== next.role.trim() ||
      prev.task.trim() !== next.task.trim()
    ) {
      lines.push(fillTeamRevisionTemplate(copy.roleChanged, { name }));
    }
    if (prev.write_capability !== next.write_capability) {
      lines.push(fillTeamRevisionTemplate(copy.writeChanged, { name }));
    }
    if (
      !sameSet(
        depKeys(prev.depends_on, canonical),
        depKeys(next.depends_on, canonical),
      )
    ) {
      lines.push(fillTeamRevisionTemplate(copy.planChanged, { name }));
    }
  }
  return lines;
}

function debateLines(
  previous: TeamPreviewRevisionSnapshot,
  current: TeamPreviewRevisionSnapshot,
): string[] {
  const copy = TEAM_PRIMITIVE_META.debate.revision;
  const lines: string[] = [];
  if (previous.motion.trim() !== current.motion.trim()) {
    lines.push(copy.motionChanged);
  }
  const prevRows = previous.sides.map((s) => ({
    ...s,
    id: s.key,
    matchKey: s.name.trim(),
  }));
  const nextRows = current.sides.map((s) => ({
    ...s,
    id: s.key,
    matchKey: s.name.trim(),
  }));
  const { pairs, added, removed } = matchByIdThenUniqueKey(prevRows, nextRows);
  for (const s of removed) {
    lines.push(
      fillTeamRevisionTemplate(copy.removed, {
        name: displayName("debate", s.name),
      }),
    );
  }
  for (const s of added) {
    lines.push(
      fillTeamRevisionTemplate(copy.added, {
        name: displayName("debate", s.name),
      }),
    );
  }
  for (const { prev, next } of pairs) {
    if (prev.name.trim() !== next.name.trim()) {
      lines.push(
        fillTeamRevisionTemplate(copy.renamed, {
          from: displayName("debate", prev.name),
          to: displayName("debate", next.name),
        }),
      );
    }
    if (prev.stance.trim() !== next.stance.trim()) {
      lines.push(
        fillTeamRevisionTemplate(copy.stanceChanged, {
          name: displayName("debate", next.name || prev.name),
        }),
      );
    }
  }
  return lines;
}

/**
 * 相对上一版的可核对变更。找不到上一版或 primitive 对不上 → unavailable，
 * 不编造 diff，也不产出「无变化」。
 */
export function teamPreviewRevisionDiff(args: {
  primitive: KickoffPrimitive;
  current: TeamPreviewRevisionSnapshot;
  previousPayload: Record<string, unknown> | null | undefined;
}): TeamPreviewRevisionDiff {
  const previous = snapshotFromPayload(args.previousPayload ?? null);
  if (!previous) return { status: "unavailable", lines: [] };
  if (previous.primitive !== args.primitive) {
    return { status: "unavailable", lines: [] };
  }
  const lines =
    args.primitive === "debate"
      ? debateLines(previous, args.current)
      : delegateLines(previous, args.current);
  return { status: "ready", lines };
}
