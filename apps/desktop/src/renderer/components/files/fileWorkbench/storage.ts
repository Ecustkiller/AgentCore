/** `ws_id = conv:<conversationId>` → its conversation id (scratch workspace). */
export function conversationIdOf(wsId: string): string | null {
  return wsId.startsWith("conv:") ? wsId.slice("conv:".length) : null;
}

/** @deprecated Legacy `folder:<id>` workspaces — retained for memory-leaf lookups. */
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

// Generic localStorage Set<string> persistence — every rail fold state (工作区段 / 记忆段 /
// 主题子夹) is "a set of ids in their non-default state". Tolerates unavailable / corrupt storage.
function loadStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

function saveStringSet(key: string, set: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* unavailable — session-only */
  }
}

// 工作区段默认折叠（只露根「文件夹」标题），展开过的记进这个 set 持久化，下次进页面沿用
// （与 FileTree 内部 per-source 目录折叠态各管一层：这一层管「整个工作区段是否展开」）。
const WS_EXPANDED_KEY = "agentcore:files-ws-expanded";

export function loadExpandedWs(): Set<string> {
  return loadStringSet(WS_EXPANDED_KEY);
}

export function saveExpandedWs(set: Set<string>): void {
  saveStringSet(WS_EXPANDED_KEY, set);
}

// 记忆段折叠态：段**默认展开**（保住老肌肉记忆），故只持久化「被折叠」的作用域——空集 =
// 全部展开（新用户零配置即得默认）。键名按 scopeKey（"global" | folderId）。
const MEMORY_COLLAPSED_KEY = "agentcore:files-memory-collapsed";

export function loadMemoryCollapsed(): Set<string> {
  return loadStringSet(MEMORY_COLLAPSED_KEY);
}

export function saveMemoryCollapsed(set: Set<string>): void {
  saveStringSet(MEMORY_COLLAPSED_KEY, set);
}

// 主题子夹展开态：**默认折叠**（懒列），故只持久化「被展开」的作用域——空集 = 全部折叠。
const MEMORY_TOPICS_EXPANDED_KEY = "agentcore:files-memory-topics-expanded";

export function loadMemoryTopicsExpanded(): Set<string> {
  return loadStringSet(MEMORY_TOPICS_EXPANDED_KEY);
}

export function saveMemoryTopicsExpanded(set: Set<string>): void {
  saveStringSet(MEMORY_TOPICS_EXPANDED_KEY, set);
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
