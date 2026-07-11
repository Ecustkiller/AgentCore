import type { FsResult } from "@shared/ipc-contract";
import { clipboard, shell } from "electron";
import { locate, realFail, realInside } from "./pathGuard";
import { ensureReady } from "./roots";

// --- 系统集成（在资源管理器中显示 / 用默认程序打开 / 复制路径）---
//
// 把 renderer 的 `{rootId, relPath}` 解析为绝对路径并 realpath 校验在根内（防越界 /
// 符号链接逃逸），再交给系统：定位 / 打开 / 写剪贴板。**绝对路径只在主进程出现**，
// 从不下发 renderer，沿用本服务的安全不变量。仅本地源会调到这里（云端无本机路径）。

/** 在系统文件管理器中定位该路径（`shell.showItemInFolder`，无成功信号，靠 realpath 校验兜存在性）。 */
export async function reveal(
  rootId: string,
  relPath: string,
): Promise<FsResult> {
  await ensureReady();
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real.ok) return realFail(real);
  shell.showItemInFolder(real.path);
  return { ok: true, data: undefined };
}

/** 用系统默认程序打开该路径（`shell.openPath` 返回非空串即失败原因）。 */
export async function openWithDefaultApp(
  rootId: string,
  relPath: string,
): Promise<FsResult> {
  await ensureReady();
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real.ok) return realFail(real);
  const err = await shell.openPath(real.path);
  if (err) return { ok: false, reason: err, code: "error" };
  return { ok: true, data: undefined };
}

/** 把该路径的绝对路径写入系统剪贴板（写入在主进程完成，绝对路径不进 renderer）。 */
export async function copyPath(
  rootId: string,
  relPath: string,
): Promise<FsResult> {
  await ensureReady();
  const loc = locate(rootId, relPath);
  if ("error" in loc) return loc.error;
  const real = await realInside(loc.root, loc.abs);
  if (!real.ok) return realFail(real);
  clipboard.writeText(real.path);
  return { ok: true, data: undefined };
}
