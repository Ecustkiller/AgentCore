function posixRel(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
}

/**
 * 仓根相对路径 → workspace 相对路径。
 *
 * 用户 SCM 在当前文件夹（desk）跑时路径已是 workspace 相对，调用方传空 `subpath`。
 * 若仍拿到容器根相对路径，strip `subpath/`；不在 subpath 下时返回 null。
 */
export function repoPathToWorkspaceRel(
  repoRelPath: string,
  subpath: string,
): string | null {
  const path = posixRel(repoRelPath);
  const base = posixRel(subpath);
  if (!base) return path;
  if (path === base) return "";
  const prefix = `${base}/`;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  return null;
}

/** workspace 相对路径 → 授权根相对（trashPath / 容器 IPC）。 */
export function workspaceRelToContainerRel(
  workspaceRelPath: string,
  subpath: string,
): string {
  const path = posixRel(workspaceRelPath);
  const base = posixRel(subpath);
  if (!base) return path;
  if (!path) return base;
  return `${base}/${path}`;
}
