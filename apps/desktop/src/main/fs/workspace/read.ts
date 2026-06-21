import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import type { WorkspaceOpResult } from "@shared/ipc-contract";
import {
  LIST_FILES_MAX_DEPTH,
  LIST_FILES_SKIP_DIRS,
  WORKSPACE_LIST_MAX,
  WORKSPACE_READ_MAX,
} from "../constants";
import { realInside, resolveLexical, toReason } from "../pathGuard";
import type { StoredRoot } from "../roots";
import { collectWorkspaceFiles } from "../tree";
import { globToRegExp, opErr, opOk, toPosix } from "./result";

export async function opRead(
  root: StoredRoot,
  relPath: string,
): Promise<WorkspaceOpResult> {
  const abs = resolveLexical(root, relPath);
  if (!abs) return opErr("OutsideWorkspace", relPath);
  let st: import("node:fs").Stats;
  try {
    st = await fs.stat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return opErr("PathNotFound", relPath);
    }
    return opErr("WorkspaceIOError", toReason(e));
  }
  if (!st.isFile()) return opErr("NotAFile", relPath);
  if (st.size > WORKSPACE_READ_MAX)
    return opErr("WorkspaceIOError", "文件过大，无法读取");
  const real = await realInside(root, abs);
  if (!real) return opErr("OutsideWorkspace", relPath);
  try {
    const buf = await fs.readFile(real);
    if (buf.includes(0))
      return opErr("WorkspaceIOError", "二进制文件，无法以文本读取");
    return opOk(buf.toString("utf-8"));
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
}

export async function opList(
  root: StoredRoot,
  directory: string,
  pattern: string,
): Promise<WorkspaceOpResult> {
  const baseAbs = resolveLexical(root, directory);
  if (!baseAbs) return opErr("OutsideWorkspace", directory);
  const baseReal = await realInside(root, baseAbs);
  // 服务端 list：base 非目录（含不存在）一律 NotADirectory。
  let baseStat: import("node:fs").Stats | undefined;
  if (baseReal) {
    try {
      baseStat = await fs.stat(baseReal);
    } catch {
      baseStat = undefined;
    }
  }
  if (!baseReal || !baseStat?.isDirectory()) {
    return opErr("NotADirectory", directory);
  }

  const recursive = pattern.includes("**");
  const re = globToRegExp(pattern);
  const results: { path: string; is_dir: boolean }[] = [];

  const walk = async (
    absDir: string,
    relFromBase: string,
    depth: number,
  ): Promise<void> => {
    if (results.length >= WORKSPACE_LIST_MAX) return;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (results.length >= WORKSPACE_LIST_MAX) break;
      const childRel = relFromBase ? `${relFromBase}/${d.name}` : d.name;
      const isDir = d.isDirectory();
      if (re.test(childRel)) {
        results.push({
          path: toPosix(relative(root.absPath, join(absDir, d.name))),
          is_dir: isDir,
        });
      }
      if (
        recursive &&
        isDir &&
        !LIST_FILES_SKIP_DIRS.has(d.name) &&
        depth + 1 <= LIST_FILES_MAX_DEPTH
      ) {
        await walk(join(absDir, d.name), childRel, depth + 1);
      }
    }
  };

  await walk(baseReal, "", 0);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return opOk(results.slice(0, WORKSPACE_LIST_MAX));
}

// index_files：把绑定根（或其 `base` 子树）扁平索引成相对文件路径列表（忽略目录剪枝 + cap），
// 返回 {paths, truncated}。服务端 LocalWorkspace.index_files 经此打通，使 @ 提及与 worker
// 工作区清单在本地根上与云端 ServerWorkspace.index_files 行为一致。`order` 选排序
// （"recent" 按 mtime 倒序供清单预算，否则字母序）。
//
// `base` = 工作区子路径（工作区对称化 D1a）：把索引限定到该子树，并把子路径前缀**拼回**各结果
// （故返回的是 root-相对路径），服务端 `LocalWorkspace._out` 再剥成工作区相对——与 list/grep
// 回填 root-相对、服务端统一剥前缀的约定一致。`""` / `"."` = 整根（现行为，无前缀）。子树尚不
// 存在（裸聊懒建后尚未产文件）→ 空列表。
export async function opIndexFiles(
  root: StoredRoot,
  order: "path" | "recent",
  base = "",
): Promise<WorkspaceOpResult> {
  const sub = base === "." ? "" : base.replace(/^\/+|\/+$/g, "");
  const baseAbs = resolveLexical(root, sub || ".");
  if (!baseAbs) return opErr("OutsideWorkspace", base);
  const baseReal = await realInside(root, baseAbs);
  if (!baseReal) return opOk({ paths: [], truncated: false });
  const { files, truncated } = await collectWorkspaceFiles(baseReal, order);
  const prefix = sub ? `${sub}/` : "";
  return opOk({ paths: files.map((f) => prefix + f.relPath), truncated });
}
