import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * sidecar 进程的缓存键：`容器根 id + 工作区子路径`（工作区对称化 D1a）。
 *
 * 同一容器根下的多个子路径工作区**各起一个** sidecar（各自 `workspaceRoot = 容器根/子路径`），
 * 故不能只按 rootId 复用——否则会撞进同一进程、跑在错误目录。空 subpath（显式添加的本地项目）
 * 退化为 `${rootId}::`，与历史只按 rootId 起的行为等价（仅多个固定后缀）。
 */
export function entryKey(rootId: string, subpath = ""): string {
  return `${rootId}::${subpath}`;
}

/**
 * 把容器根绝对路径与工作区子路径（工作区对称化 D1a）拼成 sidecar 的 `workspaceRoot`。
 *
 * 子路径非空时返回 `容器根/子路径` 并**确保该目录存在**（懒建工作区首次产文件通常已建出，但
 * 防御性 mkdir 兜底极端早到的 sidecar 回合，避免引擎绑定到不存在的目录）。空子路径 = 容器根
 * 自身（恒存在），不触盘，与历史行为逐字节一致。
 */
export async function resolveWorkspaceRoot(
  absPath: string,
  subpath?: string,
): Promise<string> {
  const sub = (subpath ?? "").replace(/^\/+|\/+$/g, "");
  if (!sub) return absPath;
  const workspaceRoot = join(absPath, sub);
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}
