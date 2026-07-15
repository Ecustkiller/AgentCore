/**
 * 云 scratch → 本地单向 checkout（双模式工作区 §八.7）。
 *
 * 用户选目录后，把云端快照 zip 解压落地。不登记授权根、不绑工作区——纯导出。
 */

import { promises as fs } from "node:fs";
import { basename, dirname, join, normalize, sep } from "node:path";
import { BrowserWindow, dialog, shell } from "electron";
import JSZip from "jszip";

export type CheckoutArchiveResult =
  | { ok: true; destName: string; fileCount: number }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "error"; message: string };

/** 拒绝 zip 内含 `..` / 绝对路径的条目，防止写出目标目录外。 */
export function safeJoinUnder(destAbs: string, entryPath: string): string | null {
  const normalized = entryPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  const target = normalize(join(destAbs, ...parts));
  const rootWithSep = destAbs.endsWith(sep) ? destAbs : destAbs + sep;
  if (target !== destAbs && !target.startsWith(rootWithSep)) return null;
  return target;
}

/**
 * 弹目录选择器，把 base64 zip 解压到所选目录（覆盖同名文件）。
 * 成功后在系统文件管理器中打开该目录。
 */
export async function checkoutArchive(
  archiveBase64: string,
): Promise<CheckoutArchiveResult> {
  if (!archiveBase64) {
    return { ok: false, reason: "error", message: "空归档" };
  }

  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = win
    ? await dialog.showOpenDialog(win, {
        properties: ["openDirectory", "createDirectory"],
      })
    : await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, reason: "cancelled" };
  }

  let destAbs: string;
  try {
    destAbs = await fs.realpath(result.filePaths[0]);
  } catch {
    destAbs = result.filePaths[0];
  }

  try {
    const zip = await JSZip.loadAsync(archiveBase64, { base64: true });
    let fileCount = 0;
    const entries = Object.values(zip.files);
    for (const entry of entries) {
      if (entry.dir) continue;
      const target = safeJoinUnder(destAbs, entry.name);
      if (!target) continue;
      await fs.mkdir(dirname(target), { recursive: true });
      const data = await entry.async("nodebuffer");
      await fs.writeFile(target, data);
      fileCount++;
    }
    try {
      await shell.openPath(destAbs);
    } catch {
      /* best-effort reveal */
    }
    return {
      ok: true,
      destName: basename(destAbs) || destAbs,
      fileCount,
    };
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      message: e instanceof Error ? e.message : "解压失败",
    };
  }
}
