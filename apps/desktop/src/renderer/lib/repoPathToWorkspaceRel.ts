/**
 * 仓根相对路径（git status / git_scm）→ workspace 相对路径（FileDetail / inPath）。
 *
 * git 在容器根跑，返回路径相对仓根；文件源在 subpath 非空时会再经 inPath 前缀。
 * 打开前须 strip `subpath/`，否则双重前缀。路径不在 subpath 下时返回 null（诚实不打开）。
 */
export function repoPathToWorkspaceRel(
  repoRelPath: string,
  subpath: string,
): string | null {
  const path = repoRelPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const base = subpath
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (!base) return path;
  if (path === base) return "";
  const prefix = `${base}/`;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  return null;
}
