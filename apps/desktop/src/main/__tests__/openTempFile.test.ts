/**
 * `fs:openTempFile`（云端文件落只读临时副本后用系统默认程序打开）主进程侧行为。
 *
 * 覆盖面即这条路径的四道要害：白名单**硬拒**（无确认逃生口）、字节上限、文件名净化 + 独占
 * 子目录、副本只读，以及只回收上次启动残留的清扫。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { OPEN_TEMP_FILE_MAX_BYTES } from "@shared/ipc-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tempRoot: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.tempRoot },
  shell: { openPath: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

import { shell } from "electron";
import { openTempFileFromBytes, sweepOpenTempOrphans } from "../fs/openTemp";

const openPath = shell.openPath as unknown as ReturnType<typeof vi.fn>;

/** 副本是只读的——Windows 上得先还回写位才删得掉（正是被测代码要处理的那件事）。 */
async function rmAll(dir: string): Promise<void> {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await rmAll(p);
    else await fs.chmod(p, 0o666).catch(() => {});
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function baseDir(): string {
  return join(mocks.tempRoot, "agentcore-open");
}

async function copyDirs(): Promise<string[]> {
  return fs.readdir(baseDir()).catch(() => []);
}

const BYTES = new Uint8Array([1, 2, 3, 4]);

beforeEach(async () => {
  mocks.tempRoot = await fs.mkdtemp(join(tmpdir(), "ac-opentemp-"));
  openPath.mockReset();
  openPath.mockResolvedValue("");
});

afterEach(async () => {
  await rmAll(mocks.tempRoot);
});

describe("openTempFileFromBytes 白名单硬拒", () => {
  it.each([
    ["脚本：批处理", "run.bat"],
    ["脚本：PowerShell", "install.ps1"],
    ["无扩展名（无法判定安全）", "README"],
    ["尾点绕过（Windows 会抹掉末尾的点）", "evil.exe."],
    ["宏启用文档", "macro.docm"],
  ])("%s → unsupported_type，且不落盘不打开", async (_label, name) => {
    const result = await openTempFileFromBytes(name, BYTES);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unsupported_type");
    // 硬拒 = 连临时副本都不落，更没有「确认后仍可开」的第二条路。
    expect(openPath).not.toHaveBeenCalled();
    await expect(fs.readdir(baseDir())).rejects.toThrow();
  });

  it("名单内类型正常放行", async () => {
    await expect(openTempFileFromBytes("报告.docx", BYTES)).resolves.toEqual({
      ok: true,
    });
    expect(openPath).toHaveBeenCalledTimes(1);
  });
});

describe("openTempFileFromBytes 字节上限", () => {
  it("超过 OPEN_TEMP_FILE_MAX_BYTES → too_large，不落盘", async () => {
    const oversized = new Uint8Array(OPEN_TEMP_FILE_MAX_BYTES + 1);

    const result = await openTempFileFromBytes("big.pdf", oversized);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("too_large");
    expect(openPath).not.toHaveBeenCalled();
    await expect(fs.readdir(baseDir())).rejects.toThrow();
  });

  it("恰好等于上限仍放行", async () => {
    const atLimit = new Uint8Array(OPEN_TEMP_FILE_MAX_BYTES);
    await expect(openTempFileFromBytes("big.pdf", atLimit)).resolves.toEqual({
      ok: true,
    });
  });
});

describe("openTempFileFromBytes 落盘", () => {
  it("文件名净化后落进临时目录，绝对路径不出现在结果里", async () => {
    const result = await openTempFileFromBytes("a/b\\c: report.txt", BYTES);

    expect(result).toEqual({ ok: true });
    const opened = String(openPath.mock.calls[0][0]);
    // 路径分隔符与 Windows 保留字符被剥掉，只剩单段 basename。
    expect(basename(opened)).toBe("a_b_c_ report.txt");
    expect(dirname(opened).startsWith(join(baseDir(), "o-"))).toBe(true);
    expect(await fs.readFile(opened)).toEqual(Buffer.from(BYTES));
  });

  it("每次打开落独占子目录，同名文件不互踩", async () => {
    await openTempFileFromBytes("report.txt", new Uint8Array([1]));
    await openTempFileFromBytes("report.txt", new Uint8Array([2]));

    const first = String(openPath.mock.calls[0][0]);
    const second = String(openPath.mock.calls[1][0]);
    expect(dirname(first)).not.toBe(dirname(second));
    expect(await fs.readFile(first)).toEqual(Buffer.from([1]));
    expect(await fs.readFile(second)).toEqual(Buffer.from([2]));
  });

  it("副本置只读——外部程序改完保存不会静默丢失", async () => {
    await openTempFileFromBytes("report.docx", BYTES);

    const opened = String(openPath.mock.calls[0][0]);
    const st = await fs.stat(opened);
    // Windows 上 chmod 即 readonly 属性，Node 回报的 mode 写位随之清零。
    expect(st.mode & 0o222).toBe(0);
  });

  it("系统打不开（无关联程序）→ error，并清掉刚落的副本", async () => {
    openPath.mockResolvedValue("没有与此文件关联的应用");

    const result = await openTempFileFromBytes("report.txt", BYTES);

    expect(result).toEqual({
      ok: false,
      reason: "error",
      message: "没有与此文件关联的应用",
    });
    expect(await copyDirs()).toEqual([]);
  });
});

describe("sweepOpenTempOrphans", () => {
  it("回收上次启动前的只读残留，保留本次会话的副本", async () => {
    const stale = join(baseDir(), "o-stale");
    await fs.mkdir(stale, { recursive: true });
    const staleFile = join(stale, "old.pdf");
    await fs.writeFile(staleFile, BYTES);
    await fs.chmod(staleFile, 0o444);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(stale, past, past);

    await openTempFileFromBytes("live.txt", BYTES);
    const liveDir = dirname(String(openPath.mock.calls[0][0]));

    await sweepOpenTempOrphans();

    // 只读文件在 Windows 上直接删会 EPERM——清扫得先还回写位，否则残留永远扫不掉。
    expect(await copyDirs()).toEqual([liveDir.split(sep).pop()]);
  });

  it("临时目录还不存在时静默返回", async () => {
    await expect(sweepOpenTempOrphans()).resolves.toBeUndefined();
  });
});
