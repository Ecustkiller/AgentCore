// Workspace-relative path arithmetic for the mobile file browser's write actions.
//
// Pure and dependency-free so the rename / move / new-folder flows can be unit-tested
// without mounting the browser. Paths are always POSIX-relative to the workspace root
// ("" = root) — the same shape the listing endpoint returns.

/** `dir/name`, or just `name` at the root. */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** The containing directory of `path` ("" when it sits at the root). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
}

/** The last segment of `path`. */
export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Why `name` cannot be a file/folder name here, or null when it is fine.
 *
 * Only refuses what would change the *meaning* of the path (separators, `.`/`..`)
 * or produce an unusable name (empty, control chars). Everything else is the
 * backend's call — inventing extra client-side policy would refuse names the
 * cloud workspace actually accepts.
 */
export function entryNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "名称不能为空";
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return "名称不能包含「/」或「\\」";
  }
  if (trimmed === "." || trimmed === "..") return "名称不能是「.」或「..」";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control chars in a filename is the point
  if (/[\0-\x1f\x7f]/.test(trimmed)) return "名称不能包含控制字符";
  return null;
}

/** True when `path` is `dir` itself or lives under it. */
export function isInsideDir(path: string, dir: string): boolean {
  if (dir === "") return true;
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Why `entry` cannot move into `targetDir`, or null when the move is allowed.
 *
 * The self/descendant guard is the one the backend cannot phrase kindly: moving a
 * folder inside itself surfaces as a raw OS error, so catch it here and say why.
 */
export function moveTargetError(
  entry: { path: string; isDir: boolean },
  targetDir: string,
): string | null {
  if (parentDir(entry.path) === targetDir) return "已经在这个文件夹里了";
  if (entry.isDir && isInsideDir(targetDir, entry.path)) {
    return "不能移动到自己或自己的子文件夹里";
  }
  return null;
}
