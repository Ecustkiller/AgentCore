import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { workspaceRootGoneMessage } from "@shared/workspaceRootGone";
import { isExistingDirectory } from "../fs/rootExists";

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
 * 把容器根绝对路径与工作区子路径拼成 sidecar 的 `workspaceRoot`。
 *
 * - 空子路径 = 用户点名的项目根：必须已是目录。不 mkdir（禁止在空路径造冒牌工程）。
 * - 非空子路径 = 容器下 scratch / 嵌套工作区：懒建 mkdir（默认 `conversations/<id>` 仍可建）。
 */
export async function resolveWorkspaceRoot(
  absPath: string,
  subpath?: string,
): Promise<string> {
  const root = (absPath ?? "").trim();
  if (!root) {
    throw new Error(workspaceRootGoneMessage());
  }
  const sub = (subpath ?? "").replace(/^\/+|\/+$/g, "");
  if (!sub) {
    if (!(await isExistingDirectory(root))) {
      throw new Error(workspaceRootGoneMessage(root));
    }
    return root;
  }
  const workspaceRoot = join(root, sub);
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}
