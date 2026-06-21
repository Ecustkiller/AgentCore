import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WorkspaceOpResult } from "@shared/ipc-contract";
import { WORKSPACE_READ_MAX } from "../constants";
import { realInside, resolveLexical, toReason } from "../pathGuard";
import type { StoredRoot } from "../roots";
import { opErr, opOk } from "./result";

/** 原子写：同目录临时文件 + rename，避免进程中断在用户真实磁盘上留下半截文件。 */
export async function atomicWrite(abs: string, data: Buffer): Promise<void> {
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
export async function resolveWritable(
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

export async function opReadBytes(
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

export async function opWrite(
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

export async function opWriteBytes(
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

export async function opMkdir(
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

export async function opDelete(
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

export async function opMove(
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

export async function opReplace(
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
