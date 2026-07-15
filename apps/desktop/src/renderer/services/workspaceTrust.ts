/**
 * Trust-on-first-use for local project directories (P2 optional).
 *
 * User-level persistence in localStorage. When a local folder path has never
 * been trusted and is not a git working tree, callers may suggest ``observe``
 * or prompt once:「信任此目录？」.
 */

const STORAGE_KEY = "agentcore.trustedWorkspaceRoots.v1";

/** In-memory fallback for vitest / non-DOM hosts. */
const memoryStore = new Map<string, string>();

function storageGet(key: string): string | null {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(key);
    }
  } catch {
    /* ignore */
  }
  return memoryStore.get(key) ?? null;
}

function storageSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
      return;
    }
  } catch {
    /* fall through */
  }
  memoryStore.set(key, value);
}

function storageRemove(key: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
  memoryStore.delete(key);
}

function readRoots(): string[] {
  try {
    const raw = storageGet(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function writeRoots(roots: string[]): void {
  storageSet(STORAGE_KEY, JSON.stringify([...new Set(roots)]));
}

function normalizeRoot(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isWorkspaceRootTrusted(path: string): boolean {
  const key = normalizeRoot(path);
  return readRoots().some((r) => normalizeRoot(r) === key);
}

export function trustWorkspaceRoot(path: string): void {
  const roots = readRoots();
  roots.push(path);
  writeRoots(roots);
}

/**
 * Suggest observe for first-touch local dirs that are not trusted.
 * Git repos are treated as already-known projects (no prompt).
 */
export function suggestObserveForUntrustedLocal(opts: {
  localRootPath: string | null | undefined;
  isGitRepo: boolean;
}): boolean {
  if (!opts.localRootPath) return false;
  if (opts.isGitRepo) return false;
  return !isWorkspaceRootTrusted(opts.localRootPath);
}

/** One-shot confirm; returns true if the user trusts the directory. */
export function confirmTrustLocalDirectory(path: string): boolean {
  if (isWorkspaceRootTrusted(path)) return true;
  const ok = window.confirm(
    `此本地目录尚未标记为可信。\n\n信任后，新会话可使用「开工授权」权限模式；否则建议保持「只观察」。\n\n信任此目录？`,
  );
  if (ok) trustWorkspaceRoot(path);
  return ok;
}

/** Test helper. */
export function clearTrustedWorkspaceRootsForTests(): void {
  storageRemove(STORAGE_KEY);
}
