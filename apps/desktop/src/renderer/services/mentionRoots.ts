/**
 * `@` 本机文件来源选择：会话绑定根优先，无绑定才按最近使用回退，并折叠嵌套根。
 *
 * 嵌套折叠与同名消歧用 `listRoots().absPath`（主进程 `fs-roots.json` 里本来就有）。
 */

import type { WorkspaceBinding } from "@/services/workspaceBinding";

/** 无绑定时最多保留几条本机来源，避免 11 个嵌套根吃光空列表名额。 */
export const FALLBACK_MENTION_ROOT_LIMIT = 4;

export interface MentionRootCandidate {
  id: string;
  name: string;
  /** OS 绝对路径（来自 `listRoots().absPath`）；用于嵌套折叠与同名消歧。 */
  absPath?: string;
}

export interface MentionRootPick {
  id: string;
  label: string;
  subpath: string;
}

export interface RootUseEvent {
  rootId: string;
  usedAt: number;
}

type BindingRef = Pick<WorkspaceBinding, "mode" | "rootId">;

/** Windows 盘符路径大小写不敏感；POSIX 保持原样。 */
export function normalizeRootPath(path: string): string {
  const win = /\\/.test(path) || /^[a-zA-Z]:/.test(path);
  const posix = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return win ? posix.toLowerCase() : posix;
}

/** `child` 是否落在 `parent` 目录树内（不含同一路径）。 */
export function isNestedRootPath(parent: string, child: string): boolean {
  const p = normalizeRootPath(parent);
  const c = normalizeRootPath(child);
  if (!p || !c || p === c) return false;
  return c.startsWith(`${p}/`);
}

function pathKey(root: MentionRootCandidate): string | null {
  return root.absPath ? normalizeRootPath(root.absPath) : null;
}

/**
 * 互为父子时只留最具体的根；同一物理路径只留一条（先出现的优先，调用方先按最近排）。
 */
export function collapseNestedRoots<T extends MentionRootCandidate>(
  roots: readonly T[],
): T[] {
  const seenPath = new Set<string>();
  const unique: T[] = [];
  for (const root of roots) {
    const key = pathKey(root);
    if (key) {
      if (seenPath.has(key)) continue;
      seenPath.add(key);
    }
    unique.push(root);
  }

  return unique.filter((root) => {
    const key = pathKey(root);
    if (!key) return true;
    return !unique.some((other) => {
      if (other.id === root.id) return false;
      const otherKey = pathKey(other);
      return otherKey != null && isNestedRootPath(key, otherKey);
    });
  });
}

function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
}

/** 同名根用父段区分（`Project/AgentCore` vs `work/AgentCore`）；仍撞车再加短 id。 */
export function disambiguateRootLabels(
  roots: readonly MentionRootCandidate[],
): Map<string, string> {
  const labels = new Map<string, string>();
  const byName = new Map<string, MentionRootCandidate[]>();
  for (const root of roots) {
    const list = byName.get(root.name) ?? [];
    list.push(root);
    byName.set(root.name, list);
  }

  for (const group of byName.values()) {
    if (group.length === 1) {
      labels.set(group[0].id, group[0].name);
      continue;
    }
    const qualified = group.map((root) => {
      const segs = root.absPath ? pathSegments(root.absPath) : [];
      const parent = segs.length >= 2 ? segs[segs.length - 2] : "";
      const base = parent ? `${parent}/${root.name}` : root.name;
      return { root, base };
    });
    const baseCount = new Map<string, number>();
    for (const row of qualified) {
      baseCount.set(row.base, (baseCount.get(row.base) ?? 0) + 1);
    }
    for (const row of qualified) {
      const label =
        (baseCount.get(row.base) ?? 0) > 1
          ? `${row.base} · ${row.root.id.slice(0, 6)}`
          : row.base;
      labels.set(row.root.id, label);
    }
  }
  return labels;
}

export function collectRootUseEvents(
  conversations: readonly {
    folderId?: string | null;
    localRootId?: string | null;
    localContainerRootId?: string | null;
    updatedAt: string;
  }[],
  folders: readonly { id: string; localRootId: string | null }[],
): RootUseEvent[] {
  const folderRoot = new Map<string, string>();
  for (const folder of folders) {
    if (folder.localRootId) folderRoot.set(folder.id, folder.localRootId);
  }
  const events: RootUseEvent[] = [];
  for (const conv of conversations) {
    const usedAt = Date.parse(conv.updatedAt);
    if (!Number.isFinite(usedAt)) continue;
    const fromFolder = conv.folderId
      ? folderRoot.get(conv.folderId)
      : undefined;
    const rootId =
      fromFolder ?? conv.localRootId ?? conv.localContainerRootId ?? null;
    if (rootId) events.push({ rootId, usedAt });
  }
  return events;
}

function lastUsedByRoot(uses: readonly RootUseEvent[]): Map<string, number> {
  const lastUsed = new Map<string, number>();
  for (const event of uses) {
    lastUsed.set(
      event.rootId,
      Math.max(lastUsed.get(event.rootId) ?? 0, event.usedAt),
    );
  }
  return lastUsed;
}

function sortByRecentUse<T extends { id: string }>(
  roots: readonly T[],
  lastUsed: Map<string, number>,
): T[] {
  return [...roots].sort((a, b) => {
    const delta = (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0);
    if (delta !== 0) return delta;
    return 0;
  });
}

export function selectBoundMentionRoot(
  binding: BindingRef | null,
  roots: readonly MentionRootCandidate[],
  subpath = "",
): MentionRootPick | null {
  if (!binding || binding.mode !== "local" || !binding.rootId) return null;
  const root = roots.find((r) => r.id === binding.rootId);
  if (!root) return null;
  const labels = disambiguateRootLabels([root]);
  return {
    id: root.id,
    label: labels.get(root.id) ?? root.name,
    subpath,
  };
}

/**
 * 无绑定 / 绑定根不在本机：先在「用过的根」里折叠嵌套，再取最近若干条。
 * 没有任何使用记录时才对全部根折叠后截断（仍不是全量平铺）。
 */
export function pickFallbackMentionRoots(
  roots: readonly MentionRootCandidate[],
  uses: readonly RootUseEvent[] = [],
  limit = FALLBACK_MENTION_ROOT_LIMIT,
): MentionRootPick[] {
  const lastUsed = lastUsedByRoot(uses);
  const used = roots.filter((r) => (lastUsed.get(r.id) ?? 0) > 0);
  const working = used.length > 0 ? used : [...roots];
  const ranked = sortByRecentUse(working, lastUsed);
  const collapsed = collapseNestedRoots(ranked);
  const picked = sortByRecentUse(collapsed, lastUsed).slice(0, limit);
  const labels = disambiguateRootLabels(picked);
  return picked.map((root) => ({
    id: root.id,
    label: labels.get(root.id) ?? root.name,
    subpath: "",
  }));
}

export function buildLocalMentionPicks(input: {
  binding: BindingRef | null;
  roots: readonly MentionRootCandidate[];
  subpath?: string;
  uses?: readonly RootUseEvent[];
  limit?: number;
}): MentionRootPick[] {
  const bound = selectBoundMentionRoot(
    input.binding,
    input.roots,
    input.subpath ?? "",
  );
  if (bound) return [bound];
  return pickFallbackMentionRoots(input.roots, input.uses ?? [], input.limit);
}
