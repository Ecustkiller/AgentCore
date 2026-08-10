/**
 * 工作区路径救援 —— 与后端 ``normalize_workspace_path`` / 桌面
 * ``apps/desktop/src/shared/workspace-path.ts`` 对齐（各端自建实现，不跨 app import）。
 *
 * 模型常吐 ``/workspace/index.html``；原样请求会查子目录 ``workspace/…`` → 404。
 */

/** 云端会话工作区默认根标签（与 ServerWorkspace.root_label 默认一致）。 */
export const DEFAULT_WORKSPACE_ROOT_LABEL = "workspace";

/**
 * 把 ``/<rootLabel>/…`` 绝对输入改写为工作区相对路径；相对输入原样返回。
 */
export function stripRootLabelPrefix(
  relativePath: string,
  rootLabel: string = DEFAULT_WORKSPACE_ROOT_LABEL,
): string {
  if (!rootLabel) return relativePath;
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.startsWith("/")) return relativePath;
  const [first, ...restParts] = normalized.replace(/^\/+/, "").split("/");
  if (first !== rootLabel) return relativePath;
  const rest = restParts.join("/");
  return rest || ".";
}

/**
 * 工具路径契约：相对工作区根 POSIX；与后端 ``normalize_workspace_path`` 对齐。
 */
export function normalizeWorkspacePath(
  relativePath: string,
  rootLabel: string = DEFAULT_WORKSPACE_ROOT_LABEL,
): string {
  if (!relativePath || relativePath === ".") return ".";
  const unified = relativePath.replace(/\\/g, "/");
  if (unified === "/") return ".";
  return stripRootLabelPrefix(unified, rootLabel);
}

/**
 * 工具 / UI 入口路径 → 工作区相对 POSIX 路径（展示、去重、预览打开共用）。
 * 空 / 裸根 ``/workspace`` → ``""``（调用方应跳过）。
 */
export function toWorkspaceRelPath(
  path: string,
  rootLabel: string = DEFAULT_WORKSPACE_ROOT_LABEL,
): string {
  const raw = path.replace(/\\/g, "/").trim();
  if (!raw) return "";
  const stripped = normalizeWorkspacePath(raw, rootLabel);
  if (stripped === "." || stripped === "") return "";
  return stripped.replace(/^\.\/+/, "");
}
