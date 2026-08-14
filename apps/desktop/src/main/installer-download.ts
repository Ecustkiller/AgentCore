/**
 * 把安装包拉到本机文件（Electron `net.fetch`，走系统代理）。
 * 不经过 electron-updater / 不经过浏览器下载栏。
 */
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { net } from "electron";
import {
  type LatestDesktopJson,
  parseLatestDesktopJson,
} from "./installer-feed";

/** 拒绝 GitHub/CDN 返回的 HTML 错误页冒充安装包。 */
export const MIN_INSTALLER_BYTES = 1_048_576;

export type InstallerProgress = {
  transferred: number;
  total: number;
};

function headerTotalBytes(res: Response): number {
  const raw = res.headers.get("content-length");
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function waitForDrain(file: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      file.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      file.off("drain", onDrain);
      reject(err);
    };
    file.once("drain", onDrain);
    file.once("error", onError);
  });
}

function waitForClose(file: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    file.end((err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function writeFetchBodyToFile(
  body: ReadableStream<Uint8Array> | null,
  destPath: string,
  onProgress: (transferred: number) => void,
): Promise<number> {
  if (!body) throw new Error("下载失败：空响应");
  const file = createWriteStream(destPath);
  let transferred = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const chunk = Buffer.from(value);
      const ok = file.write(chunk);
      transferred += chunk.byteLength;
      onProgress(transferred);
      if (!ok) await waitForDrain(file);
    }
    await waitForClose(file);
  } catch (err) {
    file.destroy();
    await unlink(destPath).catch(() => undefined);
    throw err;
  }
  return transferred;
}

export async function downloadHttpToFile(opts: {
  url: string;
  destPath: string;
  minBytes?: number;
  onProgress?: (p: InstallerProgress) => void;
}): Promise<InstallerProgress> {
  const minBytes = opts.minBytes ?? MIN_INSTALLER_BYTES;
  const res = await net.fetch(opts.url, {
    redirect: "follow",
    headers: { "user-agent": "AgentCore-desktop-updater" },
  });
  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}`);
  }
  const totalHint = headerTotalBytes(res);
  const transferred = await writeFetchBodyToFile(
    res.body,
    opts.destPath,
    (n) => {
      opts.onProgress?.({ transferred: n, total: totalHint || n });
    },
  );
  if (transferred < minBytes) {
    await unlink(opts.destPath).catch(() => undefined);
    throw new Error("下载失败：安装包不完整，请稍后重试或前往下载页");
  }
  return { transferred, total: totalHint || transferred };
}

export async function fetchLatestDesktopJson(
  url: string,
): Promise<LatestDesktopJson | null> {
  try {
    const res = await net.fetch(url, {
      headers: { "user-agent": "AgentCore-desktop-updater" },
    });
    if (!res.ok) return null;
    return parseLatestDesktopJson(await res.json());
  } catch {
    return null;
  }
}
