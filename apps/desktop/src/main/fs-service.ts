/**
 * 本地文件系统服务（主进程）。
 *
 * 职责：管理「授权根」白名单 + 持久化、对每个操作做 realpath 边界校验、
 * 实现读/写/改名/移动/删除、以及目录 watch（防抖后推送 fs:changed）。
 *
 * 安全模型：renderer 只能以 `{ rootId, relPath }` 寻址；任何解析出的绝对路径
 * 必须落在对应授权根之内（词法校验 + realpath 复核，防 `..` 与符号链接逃逸）。
 */
import { randomUUID } from "node:crypto";
import { promises as fs, type FSWatcher, watch as fsWatch } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  FS_CHANNELS,
  type FilePreview,
  type FsCreateKind,
  type FsEntry,
  type FsFileRef,
  type FsResult,
  type FsRoot,
} from "@shared/ipc-contract";
import {
  BrowserWindow,
  type WebContents,
  app,
  dialog,
  ipcMain,
} from "electron";

interface StoredRoot {
  id: string;
  name: string;
  absPath: string;
}

const TEXT_PREVIEW_CAP = 256 * 1024; // 文本预览最多读取/展示 256KB
const IMAGE_PREVIEW_CAP = 10 * 1024 * 1024; // 图片超过 10MB 退化为元信息

const LIST_FILES_CAP = 5000; // @ 提及检索：单根最多返回文件数
const LIST_FILES_MAX_DEPTH = 12; // 递归最大深度，防极深目录
// 递归列举时跳过的目录（依赖/构建产物/VCS 等，与 @ 提及无关）。
const LIST_FILES_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
  "target",
]);

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

let roots = new Map<string, StoredRoot>();
let rootsReady: Promise<void> | null = null;

// watch 状态：key = `${rootId}::${relPath}`
const watchers = new Map<string, FSWatcher>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

function storeFilePath(): string {
  return join(app.getPath("userData"), "fs-roots.json");
}

async function loadRoots(): Promise<void> {
  try {
    const raw = await fs.readFile(storeFilePath(), "utf-8");
    const arr = JSON.parse(raw) as StoredRoot[];
    roots = new Map(arr.map((r) => [r.id, r]));
  } catch {
    roots = new Map();
  }
}

async function saveRoots(): Promise<void> {
  const arr = [...roots.values()];
  try {
    await fs.writeFile(storeFilePath(), JSON.stringify(arr, null, 2), "utf-8");
  } catch (e) {
    console.error("[fs-service] 持久化授权根失败:", e);
  }
}

async function ensureReady(): Promise<void> {
  if (rootsReady) await rootsReady;
}

/** 把异常映射为对用户友好的中文原因。 */
function toReason(e: unknown): string {
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
function resolveLexical(root: StoredRoot, relPath: string): string | null {
  const abs = resolve(root.absPath, relPath);
  const rel = relative(root.absPath, abs);
  if (rel === "") return abs; // 根目录自身
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/** realpath 复核：解析真实路径并确认仍在根内（防符号链接逃逸）。 */
async function realInside(
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
function locate(
  rootId: string,
  relPath: string,
): { root: StoredRoot; abs: string } | { error: FsResult<never> } {
  const root = roots.get(rootId);
  if (!root) return { error: { ok: false, reason: "目录未授权或已移除" } };
  const abs = resolveLexical(root, relPath);
  if (!abs) return { error: { ok: false, reason: "路径越界，已拒绝" } };
  return { root, abs };
}

async function listDir(
  rootId: string,
  relPath: string,
): Promise<FsResult<FsEntry[]>> {
  await ensureReady();
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real) return { ok: false, reason: "无法访问（不存在或越界）" };
  try {
    const dirents = await fs.readdir(real, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const d of dirents) {
      const childRel = relPath ? `${relPath}/${d.name}` : d.name;
      const isDir = d.isDirectory();
      let size: number | null = null;
      let modifiedMs: number | null = null;
      try {
        const st = await fs.stat(join(real, d.name));
        size = isDir ? null : st.size;
        modifiedMs = st.mtimeMs;
      } catch {
        // 单个项 stat 失败（如失效符号链接）不影响整体列举
      }
      entries.push({
        name: d.name,
        relPath: childRel,
        kind: isDir ? "dir" : "file",
        size,
        modifiedMs,
      });
    }
    entries.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name, "zh")
        : a.kind === "dir"
          ? -1
          : 1,
    );
    return { ok: true, data: entries };
  } catch (e) {
    return { ok: false, reason: toReason(e) };
  }
}

async function readFile(
  rootId: string,
  relPath: string,
): Promise<FsResult<FilePreview>> {
  await ensureReady();
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real) return { ok: false, reason: "无法访问（不存在或越界）" };
  try {
    const st = await fs.stat(real);
    if (!st.isFile()) return { ok: false, reason: "不是文件" };

    const ext = extname(real).toLowerCase();
    const imgMime = IMAGE_MIME[ext];
    if (imgMime) {
      if (st.size > IMAGE_PREVIEW_CAP) {
        return {
          ok: true,
          data: {
            kind: "binary",
            mime: imgMime,
            size: st.size,
            reason: "图片过大，暂不预览",
          },
        };
      }
      const buf = await fs.readFile(real);
      const dataUrl = `data:${imgMime};base64,${buf.toString("base64")}`;
      return {
        ok: true,
        data: { kind: "image", dataUrl, mime: imgMime, size: st.size },
      };
    }

    // 文本/二进制：仅读取前 256KB+1 字节用于判别与展示，避免大文件全量读入。
    const fh = await fs.open(real, "r");
    try {
      const buf = Buffer.alloc(TEXT_PREVIEW_CAP + 1);
      const { bytesRead } = await fh.read(buf, 0, TEXT_PREVIEW_CAP + 1, 0);
      const data = buf.subarray(0, bytesRead);
      if (data.includes(0)) {
        return {
          ok: true,
          data: {
            kind: "binary",
            mime: "application/octet-stream",
            size: st.size,
            reason: "二进制文件，无法预览",
          },
        };
      }
      const truncated = st.size > TEXT_PREVIEW_CAP;
      const content = data
        .subarray(0, Math.min(bytesRead, TEXT_PREVIEW_CAP))
        .toString("utf-8");
      return { ok: true, data: { kind: "text", content, truncated } };
    } finally {
      await fh.close();
    }
  } catch (e) {
    return { ok: false, reason: toReason(e) };
  }
}

async function listFiles(rootId: string): Promise<FsResult<FsFileRef[]>> {
  await ensureReady();
  const loc = locate(rootId, "");
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real) return { ok: false, reason: "无法访问（不存在或越界）" };

  const files: FsFileRef[] = [];
  // 广度优先逐层展开，受深度与总数双重限制；不跟随符号链接目录，避免环路。
  const stack: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: real, rel: "", depth: 0 },
  ];
  try {
    while (stack.length > 0 && files.length < LIST_FILES_CAP) {
      const cur = stack.pop();
      if (!cur) break;
      let dirents: import("node:fs").Dirent[];
      try {
        dirents = await fs.readdir(cur.abs, { withFileTypes: true });
      } catch {
        continue; // 单个子目录不可读不影响整体
      }
      for (const d of dirents) {
        if (d.isSymbolicLink()) continue;
        const childRel = cur.rel ? `${cur.rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (LIST_FILES_SKIP_DIRS.has(d.name) || d.name.startsWith(".git")) {
            continue;
          }
          if (cur.depth + 1 <= LIST_FILES_MAX_DEPTH) {
            stack.push({
              abs: join(cur.abs, d.name),
              rel: childRel,
              depth: cur.depth + 1,
            });
          }
        } else if (d.isFile()) {
          files.push({ relPath: childRel, name: d.name });
          if (files.length >= LIST_FILES_CAP) break;
        }
      }
    }
    files.sort((a, b) => a.relPath.localeCompare(b.relPath, "zh"));
    return { ok: true, data: files };
  } catch (e) {
    return { ok: false, reason: toReason(e) };
  }
}

function isValidName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

async function rename(
  rootId: string,
  relPath: string,
  newName: string,
): Promise<FsResult> {
  await ensureReady();
  if (!isValidName(newName)) return { ok: false, reason: "名称非法" };
  if (!relPath) return { ok: false, reason: "不能重命名根目录" };
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;
  const srcReal = await realInside(loc.root, loc.abs);
  if (!srcReal) return { ok: false, reason: "源不存在或越界" };
  const destAbs = join(dirname(loc.abs), newName);
  const destRel = relative(loc.root.absPath, destAbs);
  if (destRel.startsWith("..") || isAbsolute(destRel)) {
    return { ok: false, reason: "目标越界，已拒绝" };
  }
  try {
    await fs.access(destAbs);
    return { ok: false, reason: "同名文件已存在" };
  } catch {
    // 目标不存在 —— 符合预期
  }
  try {
    await fs.rename(srcReal, destAbs);
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, reason: toReason(e) };
  }
}

async function move(
  rootId: string,
  srcRelPath: string,
  destDirRelPath: string,
): Promise<FsResult> {
  await ensureReady();
  if (!srcRelPath) return { ok: false, reason: "不能移动根目录" };
  const srcLoc = locate(rootId, srcRelPath);
  if ("error" in srcLoc) return srcLoc.error;
  const destLoc = locate(rootId, destDirRelPath);
  if ("error" in destLoc) return destLoc.error;

  const srcReal = await realInside(srcLoc.root, srcLoc.abs);
  if (!srcReal) return { ok: false, reason: "源不存在或越界" };
  const destDirReal = await realInside(destLoc.root, destLoc.abs);
  if (!destDirReal) return { ok: false, reason: "目标目录不存在或越界" };

  try {
    const st = await fs.stat(destDirReal);
    if (!st.isDirectory()) return { ok: false, reason: "目标不是目录" };
  } catch (e) {
    return { ok: false, reason: toReason(e) };
  }

  // 禁止把目录移动进自身或其子树
  const intoRel = relative(srcReal, destDirReal);
  if (intoRel === "" || (!intoRel.startsWith("..") && !isAbsolute(intoRel))) {
    return { ok: false, reason: "不能移动到自身或其子目录" };
  }

  const destAbs = join(destDirReal, basename(srcReal));
  try {
    await fs.access(destAbs);
    return { ok: false, reason: "目标位置已存在同名项" };
  } catch {
    // 目标不存在 —— 符合预期
  }
  try {
    await fs.rename(srcReal, destAbs);
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, reason: toReason(e) };
  }
}

async function create(
  rootId: string,
  relPath: string,
  kind: FsCreateKind,
): Promise<FsResult> {
  await ensureReady();
  const name = basename(relPath);
  if (!isValidName(name)) return { ok: false, reason: "名称非法" };
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;

  // 父目录必须存在且在根内
  const parentAbs = dirname(loc.abs);
  const parentReal = await realInside(loc.root, parentAbs);
  if (!parentReal) return { ok: false, reason: "父目录不存在或越界" };
  const target = join(parentReal, name);

  try {
    await fs.access(target);
    return { ok: false, reason: "已存在同名项" };
  } catch {
    // 不存在 —— 符合预期
  }
  try {
    if (kind === "dir") {
      await fs.mkdir(target);
    } else {
      const fh = await fs.open(target, "wx");
      await fh.close();
    }
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, reason: toReason(e) };
  }
}

async function remove(rootId: string, relPath: string): Promise<FsResult> {
  await ensureReady();
  if (!relPath) return { ok: false, reason: "不能删除根目录" };
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real) return { ok: false, reason: "目标不存在或越界" };
  try {
    await fs.rm(real, { recursive: true, force: false });
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, reason: toReason(e) };
  }
}

function watchDir(wc: WebContents, rootId: string, relPath: string): void {
  const root = roots.get(rootId);
  if (!root) return;
  const abs = resolveLexical(root, relPath);
  if (!abs) return;
  const key = `${rootId}::${relPath}`;
  if (watchers.has(key)) return;
  try {
    const w = fsWatch(abs, { persistent: false }, () => {
      const prev = debounceTimers.get(key);
      if (prev) clearTimeout(prev);
      debounceTimers.set(
        key,
        setTimeout(() => {
          debounceTimers.delete(key);
          if (!wc.isDestroyed()) {
            wc.send(FS_CHANNELS.changed, { rootId, relPath });
          }
        }, 150),
      );
    });
    w.on("error", () => closeWatcher(key));
    watchers.set(key, w);
  } catch {
    // 目录不可 watch（如已删除）—— 忽略，由后续 listDir 暴露错误
  }
}

function closeWatcher(key: string): void {
  const w = watchers.get(key);
  if (w) {
    w.close();
    watchers.delete(key);
  }
  const t = debounceTimers.get(key);
  if (t) {
    clearTimeout(t);
    debounceTimers.delete(key);
  }
}

function unwatchDir(rootId: string, relPath: string): void {
  closeWatcher(`${rootId}::${relPath}`);
}

function closeWatchersForRoot(rootId: string): void {
  const prefix = `${rootId}::`;
  for (const key of [...watchers.keys()]) {
    if (key.startsWith(prefix)) closeWatcher(key);
  }
}

/** 注册全部 fs IPC handler。须在 app ready 后调用。 */
export function registerFsIpc(): void {
  rootsReady = loadRoots();

  ipcMain.handle(FS_CHANNELS.addRoot, async (): Promise<FsRoot | null> => {
    await ensureReady();
    const win =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;

    let absPath: string;
    try {
      absPath = await fs.realpath(result.filePaths[0]);
    } catch {
      absPath = result.filePaths[0];
    }

    const existing = [...roots.values()].find((r) => r.absPath === absPath);
    if (existing) return { id: existing.id, name: existing.name };

    const id = randomUUID();
    const name = basename(absPath) || absPath;
    roots.set(id, { id, name, absPath });
    await saveRoots();
    return { id, name };
  });

  ipcMain.handle(FS_CHANNELS.listRoots, async (): Promise<FsRoot[]> => {
    await ensureReady();
    return [...roots.values()].map((r) => ({ id: r.id, name: r.name }));
  });

  ipcMain.handle(
    FS_CHANNELS.removeRoot,
    async (_e, payload: { rootId: string }) => {
      await ensureReady();
      closeWatchersForRoot(payload.rootId);
      roots.delete(payload.rootId);
      await saveRoots();
    },
  );

  ipcMain.handle(
    FS_CHANNELS.listDir,
    (_e, p: { rootId: string; relPath: string }) =>
      listDir(p.rootId, p.relPath),
  );

  ipcMain.handle(FS_CHANNELS.listFiles, (_e, p: { rootId: string }) =>
    listFiles(p.rootId),
  );

  ipcMain.handle(
    FS_CHANNELS.readFile,
    (_e, p: { rootId: string; relPath: string }) =>
      readFile(p.rootId, p.relPath),
  );

  ipcMain.handle(
    FS_CHANNELS.rename,
    (_e, p: { rootId: string; relPath: string; newName: string }) =>
      rename(p.rootId, p.relPath, p.newName),
  );

  ipcMain.handle(
    FS_CHANNELS.move,
    (_e, p: { rootId: string; srcRelPath: string; destRelPath: string }) =>
      move(p.rootId, p.srcRelPath, p.destRelPath),
  );

  ipcMain.handle(
    FS_CHANNELS.create,
    (_e, p: { rootId: string; relPath: string; kind: FsCreateKind }) =>
      create(p.rootId, p.relPath, p.kind),
  );

  ipcMain.handle(
    FS_CHANNELS.delete,
    (_e, p: { rootId: string; relPath: string }) => remove(p.rootId, p.relPath),
  );

  ipcMain.handle(
    FS_CHANNELS.watch,
    (e, p: { rootId: string; relPath: string }) => {
      watchDir(e.sender, p.rootId, p.relPath);
    },
  );

  ipcMain.handle(
    FS_CHANNELS.unwatch,
    (_e, p: { rootId: string; relPath: string }) => {
      unwatchDir(p.rootId, p.relPath);
    },
  );
}
