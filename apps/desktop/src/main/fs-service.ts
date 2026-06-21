/**
 * 本地文件系统服务（主进程）。
 *
 * 职责：管理「授权根」白名单 + 持久化、对每个操作做 realpath 边界校验、
 * 实现读/写/改名/移动/删除、以及目录 watch（防抖后推送 fs:changed）。
 *
 * 安全模型：renderer 只能以 `{ rootId, relPath }` 寻址；任何解析出的绝对路径
 * 必须落在对应授权根之内（词法校验 + realpath 复核，防 `..` 与符号链接逃逸）。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, type FSWatcher, watch as fsWatch } from "node:fs";
import { tmpdir } from "node:os";
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
  type FsEncoding,
  type FsEntry,
  type FsEol,
  type FsFileRef,
  type FsResult,
  type FsRoot,
  type FsTextFile,
  type FsWriteInput,
  type FsWriteResult,
  type WorkspaceOpName,
  type WorkspaceOpResult,
} from "@shared/ipc-contract";
import {
  BrowserWindow,
  type WebContents,
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
} from "electron";
import ignore, { type Ignore } from "ignore";
import JSZip from "jszip";

export interface StoredRoot {
  id: string;
  name: string;
  absPath: string;
}

const TEXT_PREVIEW_CAP = 256 * 1024; // 文本预览最多读取/展示 256KB
const IMAGE_PREVIEW_CAP = 10 * 1024 * 1024; // 图片超过 10MB 退化为元信息
const EDIT_READ_MAX = 5 * 1024 * 1024; // 「读以编辑」整文入内存上限 5 MiB（超出不在面板内编辑）

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

// --- 本地工作区 op（双模式工作区 P2）执行边界 ---
// 整文读取上限：服务端 ServerWorkspace.read 不设上限（随后由工具层截断模型可见输出），
// 但桌面在用户机器上整文读入内存，故加一道防 OOM 上限，超出按 IO 错误处理（已记差异）。
const WORKSPACE_READ_MAX = 5 * 1024 * 1024; // 5 MiB
const WORKSPACE_LIST_MAX = 100; // 与 ServerWorkspace.list 的 _MAX_LIST_ENTRIES 对齐
const GREP_MAX_LINE = 300; // 截断超长命中行（如压缩产物），与服务端对齐
const GREP_MAX_FILES = 5000; // 单次 grep 最多打开文件数
const GREP_MAX_RESULTS_CAP = 200; // 结果硬上限

// 本地→云交接打包（双模式工作区 P2e / e1）上限：防超大仓把整树读入内存/撑爆通道回填。
const ARCHIVE_MAX_FILES = 20000; // 最多打包文件数
const ARCHIVE_MAX_BYTES = 100 * 1024 * 1024; // 原始字节上限（zip 前）100 MiB

// 本地代码执行（P2c）：镜像服务端 SubprocessSandbox。命令/扩展名/超时上限一一对齐；
// 进程 cwd = 绑定的本地根（让代码与文件工具同目录，呼应服务端 cwd=workspace）。
const EXEC_LANGS: Record<string, { cmd: string[]; ext: string }> = {
  python: { cmd: ["python", "-u"], ext: ".py" },
  javascript: { cmd: ["node"], ext: ".js" },
  bash: { cmd: ["bash"], ext: ".sh" },
};
const EXEC_TIMEOUT_CAP_S = 60; // 与 code_execute 工具 60s 上限对齐（双保险）
// 单流捕获硬上限：防失控输出占内存/撑大通道回填；模型可见截断（8000）由服务端
// ExecutionResult.__post_init__ 统一处理，故此处留足余量、不抢那层语义。
const EXEC_CAPTURE_CAP = 100_000;

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

/**
 * 按 id 取一个已授权根（含绝对路径），供 sidecar 模式把 `rootId` 解析成 `workspaceRoot`。
 *
 * 与 renderer 的 `{rootId, relPath}` 寻址同源（绝对路径只存在于主进程）；本地引擎
 * （sidecar）跑在用户机器上，需要这个绝对路径作为绑定根。未授权 / 已移除返回 null。
 */
export async function getStoredRoot(
  rootId: string,
): Promise<StoredRoot | null> {
  await ensureReady();
  return roots.get(rootId) ?? null;
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

// --- 文档编辑（CodeMirror 源码编辑器）读写：完整正文 + 写前 CAS ---
//
// 与预览路径分工：预览 readFile 截断 256KB 且判别图片/二进制；编辑必须拿到完整正文，
// 截断后保存会丢尾，故走独立通道。编解码镜像参考实现：BOM/UTF-8/GBK 回退嗅探编码、
// 按 NUL 字节判二进制、回写按原文 eol 还原换行。GBK 仅可读（回写需 iconv，暂不引依赖）。

/** 前 8000 字节含 NUL 即判二进制（与服务端 / 参考实现一致）。 */
function sniffBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** 解码：BOM → utf-8-bom；合法 UTF-8 → utf-8；否则按中文场景回退 GBK（仅可读）。 */
function decodeText(buf: Buffer): { encoding: FsEncoding; text: string } {
  if (
    buf.length >= 3 &&
    buf[0] === 0xef &&
    buf[1] === 0xbb &&
    buf[2] === 0xbf
  ) {
    return {
      encoding: "utf-8-bom",
      text: new TextDecoder("utf-8").decode(buf.subarray(3)),
    };
  }
  try {
    return {
      encoding: "utf-8",
      text: new TextDecoder("utf-8", { fatal: true }).decode(buf),
    };
  } catch {
    return { encoding: "gbk", text: new TextDecoder("gbk").decode(buf) };
  }
}

/** 编码：先规一化为 `\n`，再按 eol 还原；utf-8-bom 补 BOM。GBK 不在此处（已被拒写）。 */
function encodeText(content: string, encoding: FsEncoding, eol: FsEol): Buffer {
  const normalized = content.replace(/\r\n/g, "\n");
  const withEol =
    eol === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
  if (encoding === "utf-8-bom") {
    return Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(withEol, "utf-8"),
    ]);
  }
  return Buffer.from(withEol, "utf-8");
}

async function readTextFile(
  rootId: string,
  relPath: string,
): Promise<FsResult<FsTextFile>> {
  await ensureReady();
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real) return { ok: false, reason: "无法访问（不存在或越界）" };
  try {
    const st = await fs.stat(real);
    if (!st.isFile()) return { ok: false, reason: "不是文件" };
    if (st.size > EDIT_READ_MAX) {
      return { ok: false, reason: "文件过大，暂不支持在面板内编辑" };
    }
    const buf = await fs.readFile(real);
    if (sniffBinary(buf)) return { ok: false, reason: "二进制文件，无法编辑" };
    const { encoding, text } = decodeText(buf);
    const eol: FsEol = text.includes("\r\n") ? "crlf" : "lf";
    return {
      ok: true,
      data: {
        content: text.replace(/\r\n/g, "\n"),
        mtimeMs: st.mtimeMs,
        encoding,
        eol,
      },
    };
  } catch (e) {
    return { ok: false, reason: toReason(e) };
  }
}

async function writeTextFile(
  rootId: string,
  relPath: string,
  input: FsWriteInput,
): Promise<FsWriteResult> {
  await ensureReady();
  // GBK 回写需 iconv 编码器（暂不引依赖）：拒写，避免把文件静默改成 UTF-8。
  if (input.encoding === "gbk") {
    return {
      ok: false,
      reason: "unsupported",
      message: "GBK 文件回写暂未启用",
    };
  }
  const root = roots.get(rootId);
  if (!root)
    return { ok: false, reason: "denied", message: "目录未授权或已移除" };
  const target = await resolveWritable(root, relPath);
  if (!target)
    return { ok: false, reason: "denied", message: "路径越界，已拒绝" };
  if (target === root.absPath) {
    return { ok: false, reason: "error", message: "目标是目录" };
  }

  // 写前 CAS：现存文件比对 mtime（四舍五入避毫秒抖动）；不存在则按基线区分
  // 「新建」（baseline 0）与「读过的文件已被删/移」（baseline>0 → 冲突，迫使重读）。
  let cur: import("node:fs").Stats | null = null;
  try {
    cur = await fs.stat(target);
  } catch {
    cur = null;
  }
  if (cur) {
    if (Math.round(cur.mtimeMs) !== Math.round(input.baselineMtimeMs)) {
      return { ok: false, reason: "conflict", diskMtimeMs: cur.mtimeMs };
    }
  } else if (input.baselineMtimeMs !== 0) {
    return { ok: false, reason: "conflict", diskMtimeMs: 0 };
  }

  const buf = encodeText(input.content, input.encoding, input.eol);
  try {
    await fs.mkdir(dirname(target), { recursive: true });
    await atomicWrite(target, buf);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      return { ok: false, reason: "locked", message: toReason(e) };
    }
    return { ok: false, reason: "error", message: toReason(e) };
  }
  try {
    const st = await fs.stat(target);
    return { ok: true, mtimeMs: st.mtimeMs };
  } catch (e) {
    return { ok: false, reason: "error", message: toReason(e) };
  }
}

/**
 * 工作区扁平文件索引（共享走法）：广度优先逐层展开 `real` 根，受深度（`LIST_FILES_MAX_DEPTH`）
 * 与总数（`LIST_FILES_CAP`）双重限制；跳过依赖/构建/VCS 目录，不跟随符号链接（避免环路与越界）。
 * `truncated` 表示命中 cap 截断。@ 提及检索（`listFiles`）与 worker 工作区清单（`opIndexFiles`）
 * 共用同一套走法，使本地根与云端 `ServerWorkspace.index_files` 呈现一致的扁平视图。
 *
 * `order`：`"path"`（默认）= 字母序、**不 stat**（@ 提及/选择器走法，延迟敏感）；`"recent"` =
 * 按 mtime 倒序（每文件多一次 `stat`），供 worker 清单在大树里把预算花在最可能相关的新文件上。
 */
async function collectWorkspaceFiles(
  real: string,
  order: "path" | "recent" = "path",
): Promise<{ files: FsFileRef[]; truncated: boolean }> {
  const recent = order === "recent";
  const collected: Array<{ ref: FsFileRef; mtimeMs: number }> = [];
  let truncated = false;
  const stack: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: real, rel: "", depth: 0 },
  ];
  while (stack.length > 0) {
    if (collected.length >= LIST_FILES_CAP) {
      truncated = true;
      break;
    }
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
        let mtimeMs = 0;
        if (recent) {
          try {
            mtimeMs = (await fs.stat(join(cur.abs, d.name))).mtimeMs;
          } catch {
            mtimeMs = 0; // unreadable stat → sinks to the bottom of the recent sort
          }
        }
        collected.push({ ref: { relPath: childRel, name: d.name }, mtimeMs });
        if (collected.length >= LIST_FILES_CAP) {
          truncated = true;
          break;
        }
      }
    }
  }
  if (recent) {
    collected.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  } else {
    collected.sort((a, b) => a.ref.relPath.localeCompare(b.ref.relPath, "zh"));
  }
  return { files: collected.map((c) => c.ref), truncated };
}

async function listFiles(rootId: string): Promise<FsResult<FsFileRef[]>> {
  await ensureReady();
  const loc = locate(rootId, "");
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real) return { ok: false, reason: "无法访问（不存在或越界）" };
  try {
    const { files } = await collectWorkspaceFiles(real);
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

/**
 * 复制文件/目录到**完整目标路径** `destRelPath`（与 move 收「目标目录」不同，copy 收含
 * 最终名的完整路径，故能在同目录内另存为新名——去重粘贴所需）。`fs.cp(recursive)` 递归
 * 复制；拒绝复制根、覆盖已存在目标、以及把目录复制进自身或其子树（否则会自我递归）。
 */
async function copy(
  rootId: string,
  srcRelPath: string,
  destRelPath: string,
): Promise<FsResult> {
  await ensureReady();
  if (!srcRelPath) return { ok: false, reason: "不能复制根目录" };
  const srcLoc = locate(rootId, srcRelPath);
  if ("error" in srcLoc) return srcLoc.error;
  const srcReal = await realInside(srcLoc.root, srcLoc.abs);
  if (!srcReal) return { ok: false, reason: "源不存在或越界" };

  // 目标可不存在：经 resolveWritable 校验在根内（含对已存在祖先的 realpath 复核）。
  const dstTarget = await resolveWritable(srcLoc.root, destRelPath);
  if (!dstTarget) return { ok: false, reason: "目标越界，已拒绝" };
  if (dstTarget === srcLoc.root.absPath) {
    return { ok: false, reason: "不能覆盖根目录" };
  }

  // 禁止把目录复制进自身或其子树（否则 fs.cp 会自我递归）。文件复制为同名兄弟不受影响。
  const intoRel = relative(srcReal, dstTarget);
  if (intoRel === "" || (!intoRel.startsWith("..") && !isAbsolute(intoRel))) {
    return { ok: false, reason: "不能复制到自身或其子目录" };
  }

  try {
    await fs.access(dstTarget);
    return { ok: false, reason: "目标位置已存在同名项" };
  } catch {
    // 目标不存在 —— 符合预期
  }
  try {
    await fs.mkdir(dirname(dstTarget), { recursive: true });
    await fs.cp(srcReal, dstTarget, { recursive: true, errorOnExist: true });
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

// --- 系统集成（在资源管理器中显示 / 用默认程序打开 / 复制路径）---
//
// 把 renderer 的 `{rootId, relPath}` 解析为绝对路径并 realpath 校验在根内（防越界 /
// 符号链接逃逸），再交给系统：定位 / 打开 / 写剪贴板。**绝对路径只在主进程出现**，
// 从不下发 renderer，沿用本服务的安全不变量。仅本地源会调到这里（云端无本机路径）。

/** 在系统文件管理器中定位该路径（`shell.showItemInFolder`，无成功信号，靠 realpath 校验兜存在性）。 */
async function reveal(rootId: string, relPath: string): Promise<FsResult> {
  await ensureReady();
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real) return { ok: false, reason: "无法访问（不存在或越界）" };
  shell.showItemInFolder(real);
  return { ok: true, data: undefined };
}

/** 用系统默认程序打开该路径（`shell.openPath` 返回非空串即失败原因）。 */
async function openWithDefaultApp(
  rootId: string,
  relPath: string,
): Promise<FsResult> {
  await ensureReady();
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real) return { ok: false, reason: "无法访问（不存在或越界）" };
  const err = await shell.openPath(real);
  if (err) return { ok: false, reason: err };
  return { ok: true, data: undefined };
}

/** 把该路径的绝对路径写入系统剪贴板（写入在主进程完成，绝对路径不进 renderer）。 */
async function copyPath(rootId: string, relPath: string): Promise<FsResult> {
  await ensureReady();
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real) return { ok: false, reason: "无法访问（不存在或越界）" };
  clipboard.writeText(real);
  return { ok: true, data: undefined };
}

// --- 本地工作区 op（双模式工作区 P2）---
//
// 服务端 `LocalWorkspace` 把一个 backend 方法序列化成 op 经 SSE 下发，这里在授权根上
// 执行后回填。结果信封 `WorkspaceOpResult` 的 `error.kind` 直接对应服务端的
// `WorkspaceError` 子类名（PathNotFound / OutsideWorkspace / …），从而工具层报错
// 文案与云模式 ServerWorkspace 完全一致。P2a 打通只读 read/list/grep，P2b 补齐
// read_bytes/write/write_bytes/mkdir/delete/move/replace，P2c 补 execute（本地执行）。

function opOk(value: unknown): WorkspaceOpResult {
  return { ok: true, value };
}

function opErr(kind: string, detail = "", count?: number): WorkspaceOpResult {
  return {
    ok: false,
    error: count === undefined ? { kind, detail } : { kind, detail, count },
  };
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** glob → 锚定正则：`**`=任意（含 /），`*`=非 / 段，`?`=单个非 /，其余字面转义。 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function trimLine(line: string): string {
  const s = line.trim();
  return s.length > GREP_MAX_LINE ? `${s.slice(0, GREP_MAX_LINE)} …` : s;
}

/** 读为 UTF-8 文本；二进制 / 过大 / 不可读则返回 null（grep 跳过）。 */
async function readTextSafe(abs: string): Promise<string | null> {
  try {
    const st = await fs.stat(abs);
    if (st.size > WORKSPACE_READ_MAX) return null;
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) return null;
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}

async function opRead(
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

async function opList(
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
async function opIndexFiles(
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

async function opGrep(
  root: StoredRoot,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  const pattern = String(args.pattern ?? "");
  const directory = String(args.directory ?? ".");
  const glob = args.glob ? String(args.glob) : "";
  const caseInsensitive = Boolean(args.case_insensitive);
  const filesOnly = Boolean(args.files_only);
  const maxResults = Math.max(
    1,
    Math.min(Number(args.max_results ?? 50), GREP_MAX_RESULTS_CAP),
  );

  const baseAbs = resolveLexical(root, directory);
  if (!baseAbs) return opErr("OutsideWorkspace", directory);
  const baseReal = await realInside(root, baseAbs);
  if (!baseReal) return opErr("PathNotFound", directory);
  let baseIsFile = false;
  try {
    const st = await fs.stat(baseReal);
    baseIsFile = st.isFile();
    if (!st.isDirectory() && !st.isFile()) {
      return opErr("PathNotFound", directory);
    }
  } catch {
    return opErr("PathNotFound", directory);
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern, caseInsensitive ? "i" : "");
  } catch (e) {
    return opErr("WorkspaceIOError", `非法正则：${toReason(e)}`);
  }
  const nameRe = glob ? globToRegExp(glob) : null;

  const hits: { path: string; line_no: number; text: string }[] = [];
  const fileCounts: [string, number][] = [];
  let totalMatches = 0;
  let truncated = false;
  let filesScanned = 0;
  let stop = false;

  // Scan one file's lines into the accumulators; return true if a result cap is
  // hit. Shared by the single-file fast path and the directory walk so both
  // render identical hits / counts / truncation (mirrors ServerWorkspace).
  const scanFile = async (absFile: string): Promise<boolean> => {
    const text = await readTextSafe(absFile);
    if (text === null) return false; // binary / too large / unreadable — skip
    const rel = toPosix(relative(root.absPath, absFile));
    let fileCount = 0;
    let stopLocal = false;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      fileCount++;
      totalMatches++;
      if (!filesOnly) {
        hits.push({ path: rel, line_no: i + 1, text: trimLine(lines[i]) });
        if (hits.length >= maxResults) {
          truncated = true;
          stopLocal = true;
          break;
        }
      }
    }
    if (fileCount > 0) {
      fileCounts.push([rel, fileCount]);
      if (filesOnly && fileCounts.length >= maxResults) {
        truncated = true;
        stopLocal = true;
      }
    }
    return stopLocal;
  };

  // `directory` may name a single file (rg PATTERN FILE): scan just it, no walk.
  // `glob` is moot — the file is already pinpointed.
  if (baseIsFile) {
    await scanFile(baseReal);
    return opOk({
      hits,
      file_counts: fileCounts,
      total_matches: totalMatches,
      truncated,
    });
  }

  const walk = async (absDir: string): Promise<void> => {
    if (stop) return;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (stop) break;
      if (!d.isFile()) continue;
      if (nameRe && !nameRe.test(d.name)) continue;
      filesScanned++;
      if (filesScanned > GREP_MAX_FILES) {
        truncated = true;
        stop = true;
        break;
      }
      stop = await scanFile(join(absDir, d.name));
      if (stop) break;
    }
    if (stop) return;
    for (const d of dirents) {
      if (stop) break;
      if (d.isDirectory() && !LIST_FILES_SKIP_DIRS.has(d.name)) {
        await walk(join(absDir, d.name));
      }
    }
  };

  await walk(baseReal);
  return opOk({
    hits,
    file_counts: fileCounts,
    total_matches: totalMatches,
    truncated,
  });
}

// --- 本地工作区写类 op（双模式工作区 P2b：read_bytes / write / write_bytes /
//      mkdir / delete / move / replace）---
//
// 语义与服务端 ServerWorkspace 逐一对齐：同样的错误判别式（OutsideWorkspace /
// PathNotFound / NotAFile / AlreadyExists / NotUTF8 / NoMatch / AmbiguousMatch /
// WorkspaceIOError）、同样的「建父目录」「拒绝根」「不覆盖已存在」规则，从而工具层
// 报错与返回值在两种模式下完全一致。execute（P2c）镜像 SubprocessSandbox：在绑定根
// 内跑代码。审批沿用服务端引擎层的 GRANTABLE 门——本地模式下 CEO 与被委派的 worker
// 都过门（P2d 执行门），代码到达桌面前已获用户同意，故通道本身不再设门、桌面只管执行。
// 超时由服务端按「代码自身超时 + 余量」放宽传输期限，桌面的执行超时才是真正的强杀线。

/** 原子写：同目录临时文件 + rename，避免进程中断在用户真实磁盘上留下半截文件。 */
async function atomicWrite(abs: string, data: Buffer): Promise<void> {
  const tmp = join(dirname(abs), `.tmp_ws_${randomUUID()}`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * 解析「目标可不存在」的写入路径并校验在根内（write/write_bytes/mkdir/move 目标用）。
 *
 * 词法定位先拒 `..`/绝对/同名兄弟；再对「最深的已存在祖先」做 realpath 复核，防止经
 * 符号链接祖先逃逸——与服务端 `resolve_safe_path` 的 `.resolve()` 语义对齐（不存在的
 * 尾段无法是符号链接，故只需校验已存在部分）。返回可安全写入的绝对路径，越界返回 null。
 */
async function resolveWritable(
  root: StoredRoot,
  relPath: string,
): Promise<string | null> {
  const abs = resolveLexical(root, relPath);
  if (!abs) return null;
  let existing = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      await fs.lstat(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break; // 抵达文件系统根（根目录必存在，不应触发）
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
  const realExisting = await realInside(root, existing);
  if (!realExisting) return null;
  return tail.length > 0 ? join(realExisting, ...tail) : realExisting;
}

async function opReadBytes(
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
  if (st.size > WORKSPACE_READ_MAX) {
    return opErr("WorkspaceIOError", "文件过大，无法读取");
  }
  const real = await realInside(root, abs);
  if (!real) return opErr("OutsideWorkspace", relPath);
  try {
    // JSON 无字节类型：以 base64 回填，服务端 LocalWorkspace.read_bytes 解码还原。
    return opOk((await fs.readFile(real)).toString("base64"));
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
}

async function opWrite(
  root: StoredRoot,
  relPath: string,
  content: string,
): Promise<WorkspaceOpResult> {
  const target = await resolveWritable(root, relPath);
  if (!target) return opErr("OutsideWorkspace", relPath);
  if (target === root.absPath) return opErr("WorkspaceIOError", "目标是目录");
  try {
    await fs.mkdir(dirname(target), { recursive: true });
    await atomicWrite(target, Buffer.from(content, "utf-8"));
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
  return opOk([...content].length); // 码点数，与服务端 len(content) 对齐
}

async function opWriteBytes(
  root: StoredRoot,
  relPath: string,
  base64Data: string,
): Promise<WorkspaceOpResult> {
  const target = await resolveWritable(root, relPath);
  if (!target) return opErr("OutsideWorkspace", relPath);
  if (target === root.absPath) return opErr("WorkspaceIOError", "目标是目录");
  const data = Buffer.from(base64Data, "base64");
  try {
    await fs.mkdir(dirname(target), { recursive: true });
    await atomicWrite(target, data);
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
  return opOk(data.length);
}

async function opMkdir(
  root: StoredRoot,
  relPath: string,
): Promise<WorkspaceOpResult> {
  const target = await resolveWritable(root, relPath);
  if (!target) return opErr("OutsideWorkspace", relPath);
  if (target === root.absPath) return opErr("OutsideWorkspace", relPath); // 根已存在
  try {
    await fs.lstat(target);
    return opErr("AlreadyExists", relPath);
  } catch {
    // 不存在 —— 符合预期
  }
  try {
    await fs.mkdir(target, { recursive: true });
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
  return opOk(null);
}

async function opDelete(
  root: StoredRoot,
  relPath: string,
): Promise<WorkspaceOpResult> {
  const abs = resolveLexical(root, relPath);
  if (!abs) return opErr("OutsideWorkspace", relPath);
  if (abs === root.absPath) return opErr("OutsideWorkspace", relPath); // 不删根
  try {
    await fs.lstat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return opErr("PathNotFound", relPath);
    }
    return opErr("WorkspaceIOError", toReason(e));
  }
  const real = await realInside(root, abs);
  if (!real) return opErr("OutsideWorkspace", relPath);
  try {
    await fs.rm(real, { recursive: true, force: false });
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
  return opOk(null);
}

async function opMove(
  root: StoredRoot,
  src: string,
  dst: string,
): Promise<WorkspaceOpResult> {
  const srcAbs = resolveLexical(root, src);
  if (!srcAbs) return opErr("OutsideWorkspace", src);
  if (srcAbs === root.absPath) return opErr("OutsideWorkspace", src);
  try {
    await fs.lstat(srcAbs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return opErr("PathNotFound", src);
    }
    return opErr("WorkspaceIOError", toReason(e));
  }
  const srcReal = await realInside(root, srcAbs);
  if (!srcReal) return opErr("OutsideWorkspace", src);

  const dstTarget = await resolveWritable(root, dst);
  if (!dstTarget) return opErr("OutsideWorkspace", dst);
  if (dstTarget === root.absPath) return opErr("OutsideWorkspace", dst);
  let dstExists = true;
  try {
    await fs.lstat(dstTarget);
  } catch {
    dstExists = false;
  }
  if (dstExists) return opErr("AlreadyExists", dst);
  try {
    await fs.mkdir(dirname(dstTarget), { recursive: true });
    await fs.rename(srcReal, dstTarget);
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
  return opOk(null);
}

async function opReplace(
  root: StoredRoot,
  relPath: string,
  oldStr: string,
  newStr: string,
  all: boolean,
): Promise<WorkspaceOpResult> {
  const abs = resolveLexical(root, relPath);
  if (!abs) return opErr("OutsideWorkspace", relPath);
  try {
    await fs.lstat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return opErr("PathNotFound", relPath);
    }
    return opErr("WorkspaceIOError", toReason(e));
  }
  const real = await realInside(root, abs);
  if (!real) return opErr("OutsideWorkspace", relPath);
  let st: import("node:fs").Stats;
  try {
    st = await fs.stat(real);
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
  if (!st.isFile()) return opErr("NotAFile", relPath);

  let content: string;
  try {
    const buf = await fs.readFile(real);
    // fatal 解码：非法 UTF-8 抛 TypeError → NotUTF8（对齐服务端 read_bytes().decode）。
    content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (e) {
    if (e instanceof TypeError) return opErr("NotUTF8", relPath);
    return opErr("WorkspaceIOError", toReason(e));
  }

  const count = content.split(oldStr).length - 1; // 非重叠计数，对齐 Python str.count
  if (count === 0) return opErr("NoMatch", relPath);
  if (count > 1 && !all) {
    return opErr("AmbiguousMatch", `${count} matches`, count);
  }

  let newContent: string;
  let firstLine: number | null;
  if (all) {
    newContent = content.split(oldStr).join(newStr);
    firstLine = null;
  } else {
    const idx = content.indexOf(oldStr);
    newContent =
      content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
    firstLine = content.slice(0, idx).split("\n").length; // = count("\n") + 1
  }
  try {
    await atomicWrite(real, Buffer.from(newContent, "utf-8"));
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
  return opOk({ count: all ? count : 1, first_line: firstLine });
}

/** ExecutionResult 形状的成功信封（success 可为 false——执行「跑完了但非 0 退出」）。 */
function execResult(value: {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}): WorkspaceOpResult {
  return opOk(value);
}

/**
 * 在 `cwd` 下跑一个脚本文件，捕获 stdout/stderr，超时则强杀。
 *
 * 镜像服务端 SubprocessSandbox：超时 → stdout 清空、stderr 写超时说明、exit -1；
 * 进程起不来（如 PATH 无 python）→ 失败结果而非抛错，保证通道总收到信封。永不 reject。
 */
function runSubprocess(
  cmd: string[],
  scriptFile: string,
  cwd: string,
  stdin: string | null,
  timeoutSeconds: number,
  startedMs: number,
): Promise<WorkspaceOpResult> {
  return new Promise((resolve) => {
    const [bin, ...preArgs] = cmd;
    const child = spawn(bin, [...preArgs, scriptFile], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < EXEC_CAPTURE_CAP) stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < EXEC_CAPTURE_CAP) stderr += chunk.toString("utf-8");
    });
    // 进程未读 stdin 即退出会让写入抛 EPIPE——吞掉，不让它变成未捕获错误。
    child.stdin.on("error", () => {});

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    const finish = (r: WorkspaceOpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    child.on("error", (err) => {
      finish(
        execResult({
          success: false,
          stdout,
          stderr: stderr || `Failed to start process: ${err.message}`,
          exit_code: -1,
          duration_ms: Date.now() - startedMs,
        }),
      );
    });
    child.on("close", (code) => {
      const duration_ms = Date.now() - startedMs;
      if (timedOut) {
        finish(
          execResult({
            success: false,
            stdout: "",
            stderr: `Timeout: execution exceeded ${timeoutSeconds}s`,
            exit_code: -1,
            duration_ms,
          }),
        );
        return;
      }
      finish(
        execResult({
          success: code === 0,
          stdout,
          stderr,
          exit_code: code ?? 0,
          duration_ms,
        }),
      );
    });

    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function opExecute(
  root: StoredRoot,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  const startedMs = Date.now();
  const language = String(args.language ?? "python");
  const lang = EXEC_LANGS[language];
  if (!lang) {
    return execResult({
      success: false,
      stdout: "",
      stderr: `Unsupported language: ${language}`,
      exit_code: 1,
      duration_ms: 0,
    });
  }
  const code = String(args.code ?? "");
  const stdin = args.stdin == null ? null : String(args.stdin);
  const timeoutSeconds = Math.max(
    1,
    Math.min(Number(args.timeout_seconds ?? 30), EXEC_TIMEOUT_CAP_S),
  );

  // cwd = 工作区子路径（工作区对称化 D1a）：把进程工作目录定到该子树，使本地执行与文件工具
  // 同目录（呼应服务端 cwd=workspace）。`""` / `"."` = 绑定根自身（现行为）。子树尚不存在
  // （裸聊懒建后还没产文件就先执行）→ 回退根，避免用不存在的 cwd 拉起进程而失败。
  const cwdRel = String(args.cwd ?? "");
  const sub = cwdRel === "." ? "" : cwdRel.replace(/^\/+|\/+$/g, "");
  let cwdAbs = root.absPath;
  if (sub) {
    const resolved = resolveLexical(root, sub);
    const real = resolved ? await realInside(root, resolved) : null;
    if (real) cwdAbs = real;
  }

  // 脚本写入临时目录（与服务端一致：代码文件在临时区，进程 cwd 才是工作区）。
  let tmpDir: string;
  try {
    tmpDir = await fs.mkdtemp(join(tmpdir(), "agentcore-exec-"));
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
  try {
    const scriptFile = join(tmpDir, `main${lang.ext}`);
    await fs.writeFile(scriptFile, code, "utf-8");
    return await runSubprocess(
      lang.cmd,
      scriptFile,
      cwdAbs,
      stdin,
      timeoutSeconds,
      startedMs,
    );
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- 本地→云交接打包 op（双模式工作区 P2e / e1）---
//
// 把整个绑定根打包成单个 zip（base64 回填），供服务端解包暂存并快照。套用忽略规则：
// 默认跳过集（与 @ 提及列举一致的依赖/构建/VCS 噪音）+ 根 .gitignore，避免把 node_modules
// 之类塞进交接。设文件数/字节上限防超大仓 OOM 或撑爆通道，超限置 truncated（部分交接好过
// 整体失败）。只在根内 walk 且不跟随符号链接，故越界天然不可能。

/** 载入忽略规则：默认跳过集 + 根 `.gitignore`（缺失则仅默认集）。 */
async function loadIgnore(rootAbs: string): Promise<Ignore> {
  const ig = ignore();
  // 默认跳过集按目录规则加入（"name/" 匹配整棵子树）。
  ig.add([...LIST_FILES_SKIP_DIRS].map((d) => `${d}/`));
  try {
    ig.add(await fs.readFile(join(rootAbs, ".gitignore"), "utf-8"));
  } catch {
    // 无 .gitignore —— 仅用默认集
  }
  return ig;
}

async function opArchive(
  root: StoredRoot,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  const useIgnore = args.ignore !== false; // 默认 true
  const ig = useIgnore ? await loadIgnore(root.absPath) : null;
  const zip = new JSZip();
  let fileCount = 0;
  let totalBytes = 0;
  let truncated = false;
  let stop = false;

  const walk = async (absDir: string, relFromRoot: string): Promise<void> => {
    if (stop) return;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // 单个子目录不可读不影响整体
    }
    for (const d of dirents) {
      if (stop) break;
      if (d.isSymbolicLink()) continue; // 不跟随链接，防逃逸/环路
      const childRel = relFromRoot ? `${relFromRoot}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (ig?.ignores(`${childRel}/`)) continue; // 命中目录规则 → 跳整棵子树
        await walk(join(absDir, d.name), childRel);
      } else if (d.isFile()) {
        if (ig?.ignores(childRel)) continue;
        if (fileCount >= ARCHIVE_MAX_FILES) {
          truncated = true;
          stop = true;
          break;
        }
        let buf: Buffer;
        try {
          buf = await fs.readFile(join(absDir, d.name));
        } catch {
          continue; // 单文件读失败跳过
        }
        if (totalBytes + buf.length > ARCHIVE_MAX_BYTES) {
          truncated = true;
          stop = true;
          break;
        }
        zip.file(childRel, buf);
        fileCount++;
        totalBytes += buf.length;
      }
    }
  };

  try {
    await walk(root.absPath, "");
    const archive = await zip.generateAsync({
      type: "base64",
      compression: "DEFLATE",
    });
    return opOk({
      archive,
      file_count: fileCount,
      total_bytes: totalBytes,
      truncated,
    });
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
  }
}

async function workspaceOp(req: {
  rootId: string;
  op: WorkspaceOpName;
  args: Record<string, unknown>;
}): Promise<WorkspaceOpResult> {
  await ensureReady();
  const root = roots.get(req.rootId);
  if (!root) return opErr("WorkspaceIOError", "本地目录未授权或已移除");
  return executeWorkspaceOp(root, req.op, req.args);
}

/**
 * 在给定授权根上执行一次本地工作区 op。
 *
 * 与 electron / 根注册表解耦（只收一个 `StoredRoot`），故可脱离 Electron 直接单测。
 * 顶层 try 把任何 op 内未预期的异常兜底为 `WorkspaceIOError`，保证通道永远收到一个
 * 信封而非悬挂。
 */
export async function executeWorkspaceOp(
  root: StoredRoot,
  op: WorkspaceOpName,
  args: Record<string, unknown>,
): Promise<WorkspaceOpResult> {
  try {
    switch (op) {
      case "read":
        return await opRead(root, String(args.path ?? ""));
      case "read_bytes":
        return await opReadBytes(root, String(args.path ?? ""));
      case "write":
        return await opWrite(
          root,
          String(args.path ?? ""),
          String(args.content ?? ""),
        );
      case "write_bytes":
        return await opWriteBytes(
          root,
          String(args.path ?? ""),
          String(args.data ?? ""),
        );
      case "list":
        return await opList(
          root,
          String(args.directory ?? "."),
          String(args.pattern ?? "*"),
        );
      case "index_files":
        return await opIndexFiles(
          root,
          args.order === "recent" ? "recent" : "path",
          String(args.base ?? ""),
        );
      case "mkdir":
        return await opMkdir(root, String(args.path ?? ""));
      case "delete":
        return await opDelete(root, String(args.path ?? ""));
      case "move":
        return await opMove(
          root,
          String(args.src ?? ""),
          String(args.dst ?? ""),
        );
      case "replace":
        return await opReplace(
          root,
          String(args.path ?? ""),
          String(args.old ?? ""),
          String(args.new ?? ""),
          Boolean(args.all),
        );
      case "grep":
        return await opGrep(root, args);
      case "execute":
        return await opExecute(root, args);
      case "archive":
        return await opArchive(root, args);
      default:
        return opErr("WorkspaceIOError", `本地工作区未知的操作：${op}`);
    }
  } catch (e) {
    return opErr("WorkspaceIOError", toReason(e));
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

  // 桌面 local-first 地基（双模式工作区 决策 #11）：取得默认本地工作区根，必要时自动
  // 创建 ~/Documents/AgentCore 并登记为授权根——无需用户走目录选择器，给新对话一个
  // 开箱即用的本地落地处。幂等：已存在同路径的根则复用（不重复登记）。
  ipcMain.handle(FS_CHANNELS.ensureDefaultRoot, async (): Promise<FsRoot> => {
    await ensureReady();
    const base = join(app.getPath("documents"), "AgentCore");
    await fs.mkdir(base, { recursive: true });
    let absPath: string;
    try {
      absPath = await fs.realpath(base);
    } catch {
      absPath = base;
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
    FS_CHANNELS.readTextFile,
    (_e, p: { rootId: string; relPath: string }) =>
      readTextFile(p.rootId, p.relPath),
  );

  ipcMain.handle(
    FS_CHANNELS.writeFile,
    (_e, p: { rootId: string; relPath: string; input: FsWriteInput }) =>
      writeTextFile(p.rootId, p.relPath, p.input),
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
    FS_CHANNELS.copy,
    (_e, p: { rootId: string; srcRelPath: string; destRelPath: string }) =>
      copy(p.rootId, p.srcRelPath, p.destRelPath),
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

  ipcMain.handle(
    FS_CHANNELS.workspaceOp,
    (
      _e,
      p: { rootId: string; op: WorkspaceOpName; args: Record<string, unknown> },
    ) => workspaceOp(p),
  );

  ipcMain.handle(
    FS_CHANNELS.reveal,
    (_e, p: { rootId: string; relPath: string }) => reveal(p.rootId, p.relPath),
  );

  ipcMain.handle(
    FS_CHANNELS.openPath,
    (_e, p: { rootId: string; relPath: string }) =>
      openWithDefaultApp(p.rootId, p.relPath),
  );

  ipcMain.handle(
    FS_CHANNELS.copyPath,
    (_e, p: { rootId: string; relPath: string }) =>
      copyPath(p.rootId, p.relPath),
  );
}
