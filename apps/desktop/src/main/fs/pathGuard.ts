import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { FsResult } from "@shared/ipc-contract";
import type { StoredRoot } from "./roots";
import { getRoot } from "./roots";

/** 把异常映射为对用户友好的中文原因。 */
export function toReason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "ENOENT":
      return "文件或目录不存在";
    case "EACCES":
    case "EPERM":
      return "没有访问权限";
    case "EEXIST":
      return "目标已存在";
    case "ENOTEMPTY":
      return "目录非空";
    case "EBUSY":
      return "文件被占用";
    default:
      return e instanceof Error ? e.message : String(e);
  }
}

/** 词法校验：解析相对路径并确认仍在根内（不触盘）。返回绝对路径或 null。 */
export function resolveLexical(
  root: StoredRoot,
  relPath: string,
): string | null {
  const abs = resolve(root.absPath, relPath);
  const rel = relative(root.absPath, abs);
  if (rel === "") return abs; // 根目录自身
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/** realpath 复核：解析真实路径并确认仍在根内（防符号链接逃逸）。 */
export async function realInside(
  root: StoredRoot,
  abs: string,
): Promise<string | null> {
  try {
    const real = await fs.realpath(abs);
    const rel = relative(root.absPath, real);
    if (rel === "") return real;
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return real;
  } catch {
    return null;
  }
}

/** 取根并做词法解析；失败返回判别式错误。 */
export function locate(
  rootId: string,
  relPath: string,
): { root: StoredRoot; abs: string } | { error: FsResult<never> } {
  const root = getRoot(rootId);
  if (!root) return { error: { ok: false, reason: "目录未授权或已移除" } };
  const abs = resolveLexical(root, relPath);
  if (!abs) return { error: { ok: false, reason: "路径越界，已拒绝" } };
  return { root, abs };
}
