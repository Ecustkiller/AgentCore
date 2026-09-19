import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { logDesktop } from "../log-service";
import { resolveSidecarServerDir } from "./transport";

/** 与 API uvicorn `reload_delay` 同量级：并行保存合成一次弹进程。 */
export const SIDECAR_DEV_RELOAD_DEBOUNCE_MS = 500;

const IGNORE_DIR = /(?:^|[/\\])(?:__pycache__|\.git)(?:[/\\]|$)/;
const IGNORE_EXT = /\.(?:pyc|pyo|pyd)$/i;

export function sidecarDevReloadEnabled(
  env: NodeJS.ProcessEnv = process.env,
  packaged = app.isPackaged,
): boolean {
  if (packaged) return false;
  const raw = (env.AGENTCORE_SIDECAR_RELOAD ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

export function sidecarDevReloadWatchDir(
  serverDir = resolveSidecarServerDir(),
): string {
  return join(serverDir, "agentcore");
}

export function shouldIgnoreSidecarReloadPath(
  filename: string | null,
): boolean {
  if (!filename) return false;
  if (IGNORE_DIR.test(filename)) return true;
  if (IGNORE_EXT.test(filename)) return true;
  return false;
}

export type SidecarDevReloadManager = {
  bounceForDevReload: () => number;
};

export type SidecarWatchFn = (
  dir: string,
  options: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => {
  close: () => void;
  on: (event: "error", listener: (err: Error) => void) => void;
};

export type StartSidecarDevReloadOptions = {
  packaged?: boolean;
  env?: NodeJS.ProcessEnv;
  watchDir?: string;
  debounceMs?: number;
  dirExists?: (path: string) => boolean;
  watchFn?: SidecarWatchFn;
};

/**
 * 开发态：盯 `apps/server/agentcore/`，有变动则弹已拉起的 sidecar。
 *
 * 不是 uvicorn WatchFiles（那会跟 API 同命运、2s 硬杀 SSE）。桌面自己弹自己的
 * 子进程，stdio 父进程仍是 Electron。打包态永不启用。开发态默认关（Windows
 * 监听会误报、并行改文件会掐活回合）；要对着改代码连发才显式
 * `AGENTCORE_SIDECAR_RELOAD=true`。
 */
export function startSidecarDevReload(
  manager: SidecarDevReloadManager,
  opts: StartSidecarDevReloadOptions = {},
): () => void {
  const packaged = opts.packaged ?? app.isPackaged;
  const env = opts.env ?? process.env;
  if (!sidecarDevReloadEnabled(env, packaged)) {
    return () => {};
  }

  const dir = opts.watchDir ?? sidecarDevReloadWatchDir();
  const exists = opts.dirExists ?? existsSync;
  if (!exists(dir)) {
    logDesktop({
      level: "warn",
      event: "sidecar.dev_reload_watch_missing",
      fields: { dir },
    });
    return () => {};
  }

  const debounceMs = opts.debounceMs ?? SIDECAR_DEV_RELOAD_DEBOUNCE_MS;
  const watchFn: SidecarWatchFn =
    opts.watchFn ??
    ((dir, options, listener) => {
      const w = watch(dir, options, listener);
      return {
        close: () => w.close(),
        on: (event, cb) => {
          w.on(event, cb);
        },
      };
    });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const fire = (filename: string | null) => {
    if (closed) return;
    const n = manager.bounceForDevReload();
    if (n === 0) return;
    logDesktop({
      level: "info",
      event: "sidecar.dev_reload",
      fields: { processes: n, file: filename ?? "" },
    });
  };

  let watcher: ReturnType<SidecarWatchFn>;
  try {
    watcher = watchFn(dir, { recursive: true }, (_event, filename) => {
      if (shouldIgnoreSidecarReloadPath(filename)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fire(filename);
      }, debounceMs);
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logDesktop({
      level: "warn",
      event: "sidecar.dev_reload_watch_failed",
      fields: { dir, detail },
    });
    return () => {};
  }

  watcher.on("error", (err) => {
    logDesktop({
      level: "warn",
      event: "sidecar.dev_reload_watch_failed",
      fields: { dir, detail: err.message },
    });
  });

  logDesktop({
    level: "info",
    event: "sidecar.dev_reload_watch",
    fields: { dir },
  });

  return () => {
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    watcher.close();
  };
}
