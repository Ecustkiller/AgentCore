/**
 * 开工卡修订谱系（第几版 / 意见原文 / 相对上一版变更）。
 * 文案与桌面 TEAM_PRIMITIVE_META.revision 同口径；各端全新建，不 import 桌面。
 * 上一版只从本地冷 store 取；找不到 payload 就不画 diff。
 */
import {
  type ColdInteractionEntry,
  getColdInteractionSnapshot,
} from "@/lib/coldInteractions";

type KickoffPrimitive = "delegate" | "debate";

/** 与桌面 TEAM_REVISION_CHROME / TEAM_PRIMITIVE_META.revision 逐字对齐。 */
const TEAM_REVISION_CHROME = {
  versionLabel: "第 {n} 版",
  caption: "按你的意见修订",
  noteLabel: "你交回的意见",
  noteExpand: "展开全文",
  noteCollapse: "收起",
  changesLead: "相对上一版",
  renamed: "{from} → {to}",
  roleChanged: "{name}：角色/职责有变",
  writeChanged: "{name}：写盘能力有变",
  planChanged: "{name}：计划步骤有变",
  motionChanged: "辩题有变",
  stanceChanged: "{name}：立场有变",
} as const;

export const KICKOFF_REVISION_META = {
  delegate: {
    ...TEAM_REVISION_CHROME,
    unnamed: "未命名岗",
    added: "新增 {name}",
    removed: "去掉 {name}",
  },
  debate: {
    ...TEAM_REVISION_CHROME,
    unnamed: "未命名辩手",
    added: "新增辩手 {name}",
    removed: "去掉辩手 {name}",
  },
} as const;

/** 与桌面 REVISION_NOTE_CLAMP_CHARS 同口径。 */
export const KICKOFF_REVISION_NOTE_CLIP = 60;

export function fillKickoffRevisionTemplate(
  template: string,
  vars: { n?: number; name?: string; from?: string; to?: string },
): string {
  return template
    .replaceAll("{n}", vars.n != null ? String(vars.n) : "")
    .replaceAll("{name}", vars.name ?? "")
    .replaceAll("{from}", vars.from ?? "")
    .replaceAll("{to}", vars.to ?? "");
}

export function kickoffRevisionNumber(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const n = Math.trunc(raw);
    return n >= 1 ? n : 1;
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      const t = Math.trunc(n);
      return t >= 1 ? t : 1;
    }
  }
  return 1;
}

export function kickoffRevisedFrom(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export function kickoffRevisionNote(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export function showsKickoffRevision(revision: number): boolean {
  return revision >= 2;
}

export function kickoffRevisionVersionLabel(
  primitive: KickoffPrimitive,
  revision: number,
): string | null {
  if (!showsKickoffRevision(revision)) return null;
  return fillKickoffRevisionTemplate(
    KICKOFF_REVISION_META[primitive].versionLabel,
    { n: revision },
  );
}

export function kickoffRevisionHeadline(
  revision: number,
  primitive: KickoffPrimitive = "delegate",
): string {
  const copy = KICKOFF_REVISION_META[primitive];
  const version = fillKickoffRevisionTemplate(copy.versionLabel, {
    n: revision,
  });
  return `${version} · ${copy.caption}`;
}

export function pickKickoffRevisionFields(p: Record<string, unknown>): {
  revision?: number;
  revised_from?: string;
  revision_note?: string;
} {
  const out: {
    revision?: number;
    revised_from?: string;
    revision_note?: string;
  } = {};
  if (p.revision != null && p.revision !== "") {
    out.revision = kickoffRevisionNumber(p.revision);
  }
  const from = kickoffRevisedFrom(p.revised_from);
  if (from) out.revised_from = from;
  const note = kickoffRevisionNote(p.revision_note);
  if (note) out.revision_note = note;
  return out;
}

/**
 * 上一版 required payload。空 stub / 非 team_preview → null，调用方不得编造 diff。
 */
export function lookupPriorKickoffPayload(
  revisedFrom: string | null | undefined,
  byId: Map<string, ColdInteractionEntry> = getColdInteractionSnapshot(),
): Record<string, unknown> | null {
  const id = kickoffRevisedFrom(revisedFrom);
  if (!id) return null;
  const entry = byId.get(id);
  if (!entry || entry.kind !== "team_preview") return null;
  const payload = entry.payload;
  if (!payload || Object.keys(payload).length === 0) return null;
  return payload;
}

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

type WorkerSnap = {
  run_id: string;
  role: string;
  task: string;
  depends_on: string[];
  write_capability?: "text_only" | "can_write_files";
};

type SideSnap = { key: string; name: string; stance: string };

type Snapshot = {
  primitive: KickoffPrimitive;
  workers: WorkerSnap[];
  motion: string;
  sides: SideSnap[];
};

function parseWorkers(raw: unknown): WorkerSnap[] {
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

function parseSides(raw: unknown): SideSnap[] {
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

function snapshotFromPayload(
  payload: Record<string, unknown> | null | undefined,
): Snapshot | null {
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

function depKeys(
  deps: string[],
  own: WorkerSnap[],
  toNewId: Map<string, string> | null,
): Set<string> {
  const byId = new Map(own.map((w) => [w.run_id, w]));
  const keys = new Set<string>();
  for (const id of deps) {
    const mapped = toNewId?.get(id);
    if (mapped) {
      keys.add(`id:${mapped}`);
      continue;
    }
    const role = byId.get(id)?.role.trim();
    keys.add(role ? `role:${role}` : `id:${id}`);
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
  return trimmed || KICKOFF_REVISION_META[primitive].unnamed;
}

function delegateLines(previous: Snapshot, current: Snapshot): string[] {
  const copy = KICKOFF_REVISION_META.delegate;
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
  const idMap = new Map(
    pairs
      .filter(({ prev, next }) => prev.run_id && next.run_id)
      .map(({ prev, next }) => [prev.run_id, next.run_id]),
  );
  const lines: string[] = [];
  for (const w of removed) {
    lines.push(
      fillKickoffRevisionTemplate(copy.removed, {
        name: displayName("delegate", w.role),
      }),
    );
  }
  for (const w of added) {
    lines.push(
      fillKickoffRevisionTemplate(copy.added, {
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
      lines.push(fillKickoffRevisionTemplate(copy.roleChanged, { name }));
    }
    if (prev.write_capability !== next.write_capability) {
      lines.push(fillKickoffRevisionTemplate(copy.writeChanged, { name }));
    }
    if (
      !sameSet(
        depKeys(prev.depends_on, previous.workers, idMap),
        depKeys(next.depends_on, current.workers, null),
      )
    ) {
      lines.push(fillKickoffRevisionTemplate(copy.planChanged, { name }));
    }
  }
  return lines;
}

function debateLines(previous: Snapshot, current: Snapshot): string[] {
  const copy = KICKOFF_REVISION_META.debate;
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
      fillKickoffRevisionTemplate(copy.removed, {
        name: displayName("debate", s.name),
      }),
    );
  }
  for (const s of added) {
    lines.push(
      fillKickoffRevisionTemplate(copy.added, {
        name: displayName("debate", s.name),
      }),
    );
  }
  for (const { prev, next } of pairs) {
    if (prev.name.trim() !== next.name.trim()) {
      lines.push(
        fillKickoffRevisionTemplate(copy.renamed, {
          from: displayName("debate", prev.name),
          to: displayName("debate", next.name),
        }),
      );
    }
    if (prev.stance.trim() !== next.stance.trim()) {
      lines.push(
        fillKickoffRevisionTemplate(copy.stanceChanged, {
          name: displayName("debate", next.name || prev.name),
        }),
      );
    }
  }
  return lines;
}

/**
 * 相对上一版的可读变更。prior 为 null 或形态对不上时返回空
 *（禁止编造；空也不写「无变化」）。
 */
export function diffKickoffRevision(
  current: Record<string, unknown>,
  prior: Record<string, unknown> | null,
): string[] {
  const previous = snapshotFromPayload(prior);
  const now = snapshotFromPayload(current);
  if (!previous || !now) return [];
  if (previous.primitive !== now.primitive) return [];
  return now.primitive === "debate"
    ? debateLines(previous, now)
    : delegateLines(previous, now);
}
