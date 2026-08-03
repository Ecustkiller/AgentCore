/**
 * AgentCore/trash list + restore for local roots (cloud uses REST).
 *
 * Product one-click restore **only** covers this zone. OS ``shell.trashItem``
 * deletions are a separate track — restore via the system recycle bin UI.
 * Retention aligns with server ``workspace_retention_days`` default (30).
 */

import { promises as fs } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { FsResult, WorkspaceTrashEntry } from "@shared/ipc-contract";
import { fsErr, resolveLexical } from "./pathGuard";
import { getStoredRoot } from "./roots";
import { TRASH_REL, isInternalZoneRelPath } from "./workspaceIgnore";

/** Align with ``settings.workspace_retention_days`` default. */
export const WORKSPACE_TRASH_RETENTION_DAYS = 30;

type TrashMeta = {
  original_path: string;
  deleted_at: string;
  is_dir: boolean;
  name: string;
};

function trashRootAbs(rootAbs: string): string {
  return join(rootAbs, ...TRASH_REL.split("/"));
}

function parseDeletedAt(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function readMeta(entryDir: string): Promise<TrashMeta | null> {
  const metaPath = join(entryDir, "meta.json");
  const contentPath = join(entryDir, "content");
  try {
    await fs.lstat(contentPath);
    const raw = JSON.parse(await fs.readFile(metaPath, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.original_path !== "string" || !m.original_path.trim())
      return null;
    if (typeof m.deleted_at !== "string") return null;
    const name =
      typeof m.name === "string" && m.name
        ? m.name
        : basename(m.original_path.replace(/\\/g, "/"));
    return {
      original_path: m.original_path.replace(/\\/g, "/"),
      deleted_at: m.deleted_at,
      is_dir: Boolean(m.is_dir),
      name,
    };
  } catch {
    return null;
  }
}

export async function listWorkspaceTrash(
  rootId: string,
): Promise<FsResult<WorkspaceTrashEntry[]>> {
  const root = await getStoredRoot(rootId);
  if (!root) return fsErr("not_found", "工作区根不存在");
  const trashRoot = trashRootAbs(root.absPath);
  let children: string[];
  try {
    children = await fs.readdir(trashRoot);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, data: [] };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return fsErr("error", msg || "读取软删区失败");
  }

  const cutoff =
    Date.now() - WORKSPACE_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries: WorkspaceTrashEntry[] = [];
  for (const name of children) {
    const entryDir = join(trashRoot, name);
    let st: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      st = await fs.lstat(entryDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const meta = await readMeta(entryDir);
    if (!meta) continue;
    const deleted = parseDeletedAt(meta.deleted_at);
    if (!deleted) continue;
    if (deleted.getTime() < cutoff) {
      await fs.rm(entryDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    entries.push({
      entryId: name,
      originalPath: meta.original_path,
      name: meta.name,
      isDir: meta.is_dir,
      deletedAt: meta.deleted_at,
    });
  }
  entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return { ok: true, data: entries };
}

export async function restoreWorkspaceTrash(
  rootId: string,
  entryId: string,
): Promise<FsResult> {
  if (
    !entryId ||
    entryId.includes("/") ||
    entryId.includes("\\") ||
    entryId === ".."
  ) {
    return fsErr("invalid", "无效的软删条目");
  }
  const root = await getStoredRoot(rootId);
  if (!root) return fsErr("not_found", "工作区根不存在");

  const entryDir = join(trashRootAbs(root.absPath), entryId);
  const meta = await readMeta(entryDir);
  if (!meta) return fsErr("not_found", "软删条目不存在");

  const deleted = parseDeletedAt(meta.deleted_at);
  if (
    !deleted ||
    deleted.getTime() <
      Date.now() - WORKSPACE_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ) {
    await fs.rm(entryDir, { recursive: true, force: true }).catch(() => {});
    return fsErr(
      "invalid",
      `软删条目已超过 ${WORKSPACE_TRASH_RETENTION_DAYS} 天保留期`,
    );
  }

  const rel = meta.original_path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.includes("..") || isInternalZoneRelPath(rel)) {
    return fsErr("invalid", "软删元数据路径非法");
  }
  const destAbs = resolveLexical(root, rel);
  if (!destAbs) return fsErr("invalid", "软删元数据路径非法");
  const destResolved = resolve(destAbs);
  const rootResolved = resolve(root.absPath);
  const relCheck = relative(rootResolved, destResolved);
  if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
    return fsErr("invalid", "软删元数据路径非法");
  }

  try {
    await fs.lstat(destAbs);
    return fsErr("exists", `目标路径已存在，无法还原：${rel}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      const msg = e instanceof Error ? e.message : String(e);
      return fsErr("error", msg || "还原失败");
    }
  }

  const content = join(entryDir, "content");
  try {
    await fs.mkdir(dirname(destAbs), { recursive: true });
    await fs.rename(content, destAbs);
    await fs.rm(entryDir, { recursive: true, force: true }).catch(() => {});
    return { ok: true, data: undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fsErr("error", msg || "还原失败");
  }
}
