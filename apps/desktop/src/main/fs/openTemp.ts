/**
 * 云端文件「用本机默认应用打开」（`fs:openTempFile`）：把 renderer 交来的字节落一份**只读**
 * 临时副本，再交 OS 关联程序打开。
 *
 * 为什么存在：云端工作区文件存在服务器上、本机没有实体，`fs/shell.ts` 的 `openPath`（开授权
 * 根内的真实文件）对它无从下手——先落地成本机文件是唯一的打开路径。
 *
 * 与 `openPath` 的策略差异（表共用、策略各表达，见 {@link ../../shared/openable-ext.ts}）：
 * 本模块对白名单外的扩展名**直接拒**，不给 native 确认逃生口。字节来源是 AI 产出而非用户自己
 * 的盘，「弹框让用户点确认」对这个来源不构成防线。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  OPEN_TEMP_FILE_MAX_BYTES,
  type OpenTempFileResult,
} from "@shared/ipc-contract";
import { isSafeOpenExt } from "@shared/openable-ext";
import { app, shell } from "electron";
import { sanitizeFilename } from "./save";

/** 副本根目录（`<temp>/agentcore-open/o-XXXXXX/<文件名>`）。 */
const BASE_DIR_NAME = "agentcore-open";
const COPY_DIR_PREFIX = "o-";

/** 模块加载 ≈ 进程启动：早于这一刻的副本目录才可能是上次会话的残留。 */
const APP_START_MS = Date.now();

function baseDir(): string {
  return join(app.getPath("temp"), BASE_DIR_NAME);
}

/**
 * 删除一个副本目录。副本是只读的，而 Windows 上带 readonly 属性的文件直接删会 EPERM，
 * 所以先把写位还回去（POSIX 下这步多余但无害）。
 */
async function removeCopyDir(dir: string): Promise<void> {
  try {
    for (const name of await fs.readdir(dir)) {
      await fs.chmod(join(dir, name), 0o666).catch(() => {});
    }
  } catch {
    /* 读不到就直接尝试删 */
  }
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * 落只读临时副本并用系统默认程序打开。
 *
 * 每次打开落一个独占的 mkdtemp 子目录：同名文件（多个对话里都叫 `报告.docx`）各占一格，
 * 不会互相覆盖，也不会把还开着的那份换掉。绝对路径不回传 renderer。
 */
export async function openTempFileFromBytes(
  suggestedName: string,
  bytes: Uint8Array,
): Promise<OpenTempFileResult> {
  // 按**净化后**的名字判白名单：那才是真正落盘、真正决定 OS 关联的名字（`evil.exe.` 的尾点
  // 被净化掉后暴露出 `.exe`；`isSafeOpenExt` 自身也按 Windows 的规矩再规整一次）。
  const fileName = sanitizeFilename(suggestedName);
  if (!isSafeOpenExt(fileName)) {
    return {
      ok: false,
      reason: "unsupported_type",
      message: "这种文件类型不能用本机程序打开，请先下载再自行处理",
    };
  }
  if (bytes.byteLength > OPEN_TEMP_FILE_MAX_BYTES) {
    const mb = Math.round(OPEN_TEMP_FILE_MAX_BYTES / (1024 * 1024));
    return {
      ok: false,
      reason: "too_large",
      message: `文件超过 ${mb}MB，无法直接打开，请改用「下载」`,
    };
  }

  let dir: string;
  try {
    const base = baseDir();
    await fs.mkdir(base, { recursive: true });
    dir = await fs.mkdtemp(join(base, COPY_DIR_PREFIX));
  } catch {
    return { ok: false, reason: "error", message: "无法创建临时目录" };
  }

  const absPath = join(dir, fileName);
  try {
    await fs.writeFile(absPath, bytes);
    // 只读是主防线：外部程序（Word / Excel）会显示「只读」逼用户另存为，否则用户在副本上改完
    // 保存、以为存进了云端工作区，实际改动躺在本机临时目录里静默丢失（本期不做回写）。置不上
    // 就别开——宁可打不开，也不给一个「改了会丢」的可写副本。Windows 上 chmod 即 readonly 属性。
    await fs.chmod(absPath, 0o444);
  } catch {
    await removeCopyDir(dir).catch(() => {});
    return { ok: false, reason: "error", message: "无法写入临时副本" };
  }

  // shell.openPath 返回空串表示成功，非空即系统层错误信息（与 fs/checkout.ts 一致）。
  let err: string;
  try {
    err = await shell.openPath(absPath);
  } catch {
    err = "系统未能打开该文件";
  }
  if (err) {
    await removeCopyDir(dir).catch(() => {});
    return { ok: false, reason: "error", message: err };
  }
  return { ok: true };
}

/**
 * 启动清扫：删掉早于本次启动的临时副本目录。
 *
 * 副本得活到外部程序真正读完（`openPath` 返回后立刻删，Word 只会打开一个空文件），所以本次
 * 会话内无从回收；不扫就随每次打开永久堆积。只回收早于本次启动的目录，故正在被打开的副本
 * 天然免疫——对标 `fs/stageAttachment.ts` 的 `sweepStagingOrphans`。
 */
export async function sweepOpenTempOrphans(): Promise<void> {
  const base = baseDir();
  let names: string[];
  try {
    names = await fs.readdir(base);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(base, name);
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory() || st.mtimeMs >= APP_START_MS) continue;
      await removeCopyDir(dir);
    } catch {
      /* 留给下次启动再扫 */
    }
  }
}
