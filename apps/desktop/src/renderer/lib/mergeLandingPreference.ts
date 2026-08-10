/**
 * 云桌 → 本机「合回落点」桌面偏好（§五 · §7.6）。
 *
 * 会话或项目 → 本机授权根 id；≠ createFolder(mode=local)、≠「本地工作区」。
 * 仅桌面 UI 持久化（uiStorage）；不新建服务端契约。
 */

import { uiGet, uiSet } from "@/lib/uiStorage";

const STORAGE_KEY = "merge-landing";

export type MergeLandingScope =
  | { kind: "folder"; folderId: string }
  | { kind: "conv"; conversationId: string };

export type MergeLandingEntry = {
  rootId: string;
};

type Store = Record<string, MergeLandingEntry>;

function scopeKey(scope: MergeLandingScope): string {
  return scope.kind === "folder"
    ? `folder:${scope.folderId}`
    : `conv:${scope.conversationId}`;
}

function readStore(): Store {
  const raw = uiGet<unknown>(STORAGE_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Store = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || typeof v !== "object" || v == null || Array.isArray(v)) continue;
    const rootId = (v as { rootId?: unknown }).rootId;
    if (typeof rootId === "string" && rootId.trim()) {
      out[k] = { rootId: rootId.trim() };
    }
  }
  return out;
}

function writeStore(store: Store): void {
  if (Object.keys(store).length === 0) uiSet(STORAGE_KEY, undefined);
  else uiSet(STORAGE_KEY, store);
}

/** 云项目会话按 folderId 共享落点；裸聊云 scratch 按 conversationId。 */
export function resolveMergeLandingScope(
  conversationId: string,
  folderId: string | null | undefined,
): MergeLandingScope {
  const fid = folderId?.trim();
  if (fid) return { kind: "folder", folderId: fid };
  return { kind: "conv", conversationId };
}

export function getMergeLanding(
  scope: MergeLandingScope,
): MergeLandingEntry | null {
  return readStore()[scopeKey(scope)] ?? null;
}

export function setMergeLanding(
  scope: MergeLandingScope,
  rootId: string,
): void {
  const id = rootId.trim();
  if (!id) return;
  const store = readStore();
  store[scopeKey(scope)] = { rootId: id };
  writeStore(store);
}

export function clearMergeLanding(scope: MergeLandingScope): void {
  const store = readStore();
  const key = scopeKey(scope);
  if (!(key in store)) return;
  delete store[key];
  writeStore(store);
}
