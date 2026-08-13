/**
 * 本地工作区「命名版本」的列举与删除（`AgentCore/versions/<version_id>/`）。
 *
 * 创建 / 恢复走 sidecar JSON-RPC —— zip / unzip 只在 Python 侧留一份实现；这两个
 * 操作只是读目录 + 读 json + 删目录，走更轻的 FS IPC。盘上约定与安全校验照搬软删区
 * `workspaceTrash.ts`：id 必须是单段合法名、目录名为准、元数据缺失即跳过。
 *
 * 与软删区的关键差异：用户命名版本**永不自动清理**（对齐云端既有定案），这里没有
 * 保留期扫描，只有显式 {@link deleteWorkspaceVersion} 才会删。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { FsResult, WorkspaceVersionEntry } from "@shared/ipc-contract";
import { fsErr, resolveLexical } from "./pathGuard";
import { type StoredRoot, getStoredRoot } from "./roots";
import { VERSIONS_REL } from "./workspaceIgnore";

/** 版本内容 zip 与元数据的文件名 —— 与服务端 `workspace/versions.py` 对齐。 */
export const VERSION_CONTENT_NAME = "content.zip";
export const VERSION_META_NAME = "meta.json";

/** 与服务端 `versions._VERSION_ID_RE` 对齐（id 由 Python 侧生成，这里只做守卫）。 */
const VERSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** id 必须是单段合法名——它会被拼进路径，禁止分隔符 / 回溯 / 空字节。 */
export function isValidVersionId(versionId: string): boolean {
  const id = versionId.trim();
  if (!id || id === "." || id === "..") return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\0")) return false;
  return VERSION_ID_RE.test(id);
}

/**
 * 版本区绝对路径；`subpath` 是工作区在授权根内的相对子路径（裸聊 scratch /
 * 项目子目录），根自身传空串。越界返回 null（`resolveLexical` 词法守卫）。
 */
function versionsRootAbs(root: StoredRoot, subpath: string): string | null {
  const base = subpath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const rel = base ? `${base}/${VERSIONS_REL}` : VERSIONS_REL;
  return resolveLexical(root, rel);
}

/**
 * 读一个版本目录的元数据；缺 `content.zip`（写了一半的创建）或元数据畸形返回 null，
 * 以免把恢复不了的版本当还原点列出来。目录名为 id 权威源。
 */
async function readVersionMeta(
  entryDir: string,
  versionId: string,
): Promise<WorkspaceVersionEntry | null> {
  try {
    const content = await fs.lstat(join(entryDir, VERSION_CONTENT_NAME));
    if (!content.isFile()) return null;
    const raw = JSON.parse(
      await fs.readFile(join(entryDir, VERSION_META_NAME), "utf-8"),
    ) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.name !== "string" || !m.name.trim()) return null;
    if (typeof m.created_at !== "string" || !m.created_at.trim()) return null;
    const size = Number(m.size_bytes);
    return {
      versionId,
      name: m.name,
      createdAt: m.created_at,
      sizeBytes: Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0,
    };
  } catch {
    return null;
  }
}

/** 列出本地工作区的用户命名版本（新 → 旧）；版本区不存在视为空列表。 */
export async function listWorkspaceVersions(
  rootId: string,
  subpath: string,
): Promise<FsResult<WorkspaceVersionEntry[]>> {
  const root = await getStoredRoot(rootId);
  if (!root) return fsErr("not_found", "工作区根不存在");
  const versionsRoot = versionsRootAbs(root, subpath);
  if (!versionsRoot) return fsErr("out_of_root", "工作区子路径越界");

  let children: string[];
  try {
    children = await fs.readdir(versionsRoot);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, data: [] };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return fsErr("error", msg || "读取版本区失败");
  }

  const entries: WorkspaceVersionEntry[] = [];
  for (const name of children) {
    if (!isValidVersionId(name)) continue;
    const entryDir = join(versionsRoot, name);
    try {
      const st = await fs.lstat(entryDir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = await readVersionMeta(entryDir, name);
    if (meta) entries.push(meta);
  }
  entries.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.versionId.localeCompare(a.versionId),
  );
  return { ok: true, data: entries };
}

/** 删除一个用户命名版本目录（不可撤销；命名版本没有自动过期一说）。 */
export async function deleteWorkspaceVersion(
  rootId: string,
  subpath: string,
  versionId: string,
): Promise<FsResult> {
  if (!isValidVersionId(versionId)) {
    return fsErr("invalid", "无效的版本标识");
  }
  const root = await getStoredRoot(rootId);
  if (!root) return fsErr("not_found", "工作区根不存在");
  const versionsRoot = versionsRootAbs(root, subpath);
  if (!versionsRoot) return fsErr("out_of_root", "工作区子路径越界");

  const entryDir = join(versionsRoot, versionId.trim());
  try {
    const st = await fs.lstat(entryDir);
    if (!st.isDirectory()) return fsErr("not_found", "版本不存在");
  } catch {
    return fsErr("not_found", "版本不存在");
  }
  try {
    await fs.rm(entryDir, { recursive: true, force: true });
    return { ok: true, data: undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fsErr("error", msg || "删除版本失败");
  }
}
