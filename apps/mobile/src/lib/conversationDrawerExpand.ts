/**
 * 手机对话抽屉 · 组折叠 persist（纯函数 + localStorage）。
 *
 * 不共享桌面 sidebar store。无 stored 时默认**全展开**（不要学桌面「只展开当前组」）。
 * 组内有「等你」时计算覆盖 persist 强制展开，这次展开本身不写回。
 */

const STORAGE_KEY = "agentcore.mobile.conversationDrawerExpand";

export type DrawerGroupExpandMap = Record<string, boolean>;

/** Storage key — exported for tests only. */
export const CONVERSATION_DRAWER_EXPAND_KEY = STORAGE_KEY;

/**
 * 组是否展开。`hasRequired` 盖过 persist；无 stored 默认展开；有 stored 用 stored。
 */
export function isDrawerGroupExpanded(opts: {
  stored: boolean | undefined;
  hasRequired: boolean;
}): boolean {
  if (opts.hasRequired) return true;
  return opts.stored !== undefined ? opts.stored : true;
}

function parseMap(raw: string | null): DrawerGroupExpandMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: DrawerGroupExpandMap = {};
    for (const [folderId, expanded] of Object.entries(parsed)) {
      if (typeof expanded === "boolean") out[folderId] = expanded;
    }
    return out;
  } catch {
    return {};
  }
}

/** 读出 persist 表。缺键 / 坏 JSON → `{}`。 */
export function readDrawerGroupExpand(): DrawerGroupExpandMap {
  try {
    return parseMap(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

/**
 * 按**显示值**写入某一组（true=展开）。等你强制展开本身不要调用本函数。
 */
export function writeDrawerGroupExpand(
  folderId: string,
  expanded: boolean,
): void {
  if (!folderId) return;
  const next = { ...readDrawerGroupExpand(), [folderId]: expanded };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}

/** 测试用：清掉 persist。 */
export function resetDrawerGroupExpandForTests(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}
