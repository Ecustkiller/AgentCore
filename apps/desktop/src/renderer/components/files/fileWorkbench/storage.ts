/** `ws_id = folder:<id>` → its folder id (lifecycle ops are folder ops). */
export function folderIdOf(wsId: string): string | null {
  return wsId.startsWith("folder:") ? wsId.slice("folder:".length) : null;
}

const RAIL_KEY = "agentcore:files-rail-width";
const RAIL_MIN = 200;
const RAIL_MAX = 600;
const RAIL_DEFAULT = 288; // = Tailwind w-72，沿用旧固定宽度作默认

export function clampRail(px: number): number {
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
}

export function loadRailWidth(): number {
  try {
    const raw = localStorage.getItem(RAIL_KEY);
    if (!raw) return RAIL_DEFAULT;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? clampRail(n) : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
}

export function saveRailWidth(px: number): void {
  try {
    localStorage.setItem(RAIL_KEY, String(px));
  } catch {
    /* unavailable — session-only */
  }
}

// 工作区段默认折叠（只露根「文件夹」标题），展开过的记进这个 set 持久化，下次进页面沿用
// （与 FileTree 内部 per-source 目录折叠态各管一层：这一层管「整个工作区段是否展开」）。
const WS_EXPANDED_KEY = "agentcore:files-ws-expanded";

export function loadExpandedWs(): Set<string> {
  try {
    const raw = localStorage.getItem(WS_EXPANDED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

export function saveExpandedWs(set: Set<string>): void {
  try {
    localStorage.setItem(WS_EXPANDED_KEY, JSON.stringify([...set]));
  } catch {
    /* unavailable — session-only */
  }
}

export interface Tab {
  wsId: string;
  path: string;
  name: string;
}

/** Stable per-file key (a workspace's path is unique within it). */
export function tabKey(wsId: string, path: string): string {
  return `${wsId}:${path}`;
}
