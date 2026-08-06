/**
 * LocalChromiumHost **顶级导航策略**。
 *
 * 两种页模式（L1b 分 partition，锁也分）：
 * - **web**：仅放行 `http:` / `https:` 与 `about:blank`；`window.open` 按 disposition
 *   分流（popup → 同 partition 子窗；target=_blank → 同壳新页签；危险 scheme deny）；
 * - **workspace**：仅放行 `workspace://` 与 `about:blank`；安全 http(s) 外链转
 *   `shell.openExternal`；其余拒；`window.open` 同规则。
 *
 * 下载默认拒绝（见 {@link attachLocalBrowserDownloadGuard}，L1）。
 * URL 判定纯函数见 navigation-policy.ts。
 */

import { isSafeExternalUrl } from "@shared/safe-url";
import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type Session,
  type WebContents,
  shell,
} from "electron";
import {
  isAllowedWebBrowserUrl,
  isAllowedWorkspaceBrowserUrl,
  isNavigableLocalBrowserUrl,
  parseWindowOpenFeatures,
  resolveWebWindowOpenRoute,
} from "./navigation-policy";

export type LocalBrowserNavMode = "web" | "workspace";

export {
  LOCAL_BROWSER_BLANK,
  isAllowedLocalBrowserUrl,
  isAllowedWebBrowserUrl,
  isAllowedWorkspaceBrowserUrl,
  isNavigableLocalBrowserUrl,
  parseWindowOpenFeatures,
  resolveBridgeNavigateKind,
  resolveWebWindowOpenRoute,
  type WebWindowOpenRoute,
  type WindowOpenDisposition,
} from "./navigation-policy";

/**
 * web 模式 window.open 钩子：同 conversation partition 子窗 + 同壳页签请求。
 * workspace 模式不传（保持 openExternal / deny）。
 */
export interface LocalBrowserWebOpenHooks {
  partition: string;
  getParentWindow: () => BrowserWindow | null;
  /** 普通 target=_blank → 通知 renderer 开同壳页签。 */
  requestShellTab: (url: string, background: boolean) => void;
  /** 登记 popup 子窗（对话关闭时一并关掉）。 */
  trackPopup: (win: BrowserWindow) => void;
}

/**
 * 给 WebContents 挂导航锁（创建视图时按 partition 模式调用一次）。
 * web 模式须传 {@link LocalBrowserWebOpenHooks}，否则 window.open 一律 deny（fail-closed）。
 */
export function lockLocalBrowserNavigation(
  wc: WebContents,
  mode: LocalBrowserNavMode = "web",
  hooks?: LocalBrowserWebOpenHooks,
): void {
  if (mode === "workspace") {
    lockWorkspaceBrowserNavigation(wc);
    return;
  }

  wc.on("will-navigate", (event, target) => {
    if (isAllowedWebBrowserUrl(target)) return;
    event.preventDefault();
    console.warn(`[browser] blocked navigation to: ${target}`);
  });

  wc.setWindowOpenHandler((details) => {
    if (!hooks) {
      console.warn(`[browser] denied window.open (no hooks): ${details.url}`);
      return { action: "deny" };
    }
    return handleWebWindowOpen(details, hooks);
  });
}

function handleWebWindowOpen(
  details: {
    url: string;
    disposition: string;
    features: string;
  },
  hooks: LocalBrowserWebOpenHooks,
): {
  action: "allow" | "deny";
  createWindow?: (options: BrowserWindowConstructorOptions) => WebContents;
} {
  const route = resolveWebWindowOpenRoute({
    url: details.url,
    disposition: details.disposition,
  });

  if (route === "deny") {
    console.warn(`[browser] denied window.open for: ${details.url}`);
    return { action: "deny" };
  }

  if (route === "tab") {
    const raw = typeof details.url === "string" ? details.url.trim() : "";
    if (isNavigableLocalBrowserUrl(raw)) {
      hooks.requestShellTab(raw, details.disposition === "background-tab");
    } else {
      console.warn(`[browser] denied shell-tab for: ${details.url}`);
    }
    // 由壳内新页签承载；deny 掉 Chromium 默认新窗。
    return { action: "deny" };
  }

  // popup：同 partition 独立小窗，保留 opener / 同 session（OAuth 正途）。
  const size = parseWindowOpenFeatures(details.features);
  return {
    action: "allow",
    createWindow: (options) => {
      const parent = hooks.getParentWindow();
      const win = new BrowserWindow({
        ...options,
        width: size.width,
        height: size.height,
        ...(size.x !== undefined ? { x: size.x } : {}),
        ...(size.y !== undefined ? { y: size.y } : {}),
        autoHideMenuBar: true,
        ...(parent && !parent.isDestroyed() ? { parent } : {}),
        webPreferences: {
          ...options.webPreferences,
          partition: hooks.partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
          // 刻意不挂 preload —— 浏览页不得拿应用 IPC。
        },
      });
      hooks.trackPopup(win);
      // 递归挂锁：弹窗内再 window.open 同样分流。
      lockLocalBrowserNavigation(win.webContents, "web", hooks);
      return win.webContents;
    },
  };
}

function lockWorkspaceBrowserNavigation(wc: WebContents): void {
  wc.on("will-navigate", (event, target) => {
    if (isAllowedWorkspaceBrowserUrl(target)) return;
    event.preventDefault();
    if (isSafeExternalUrl(target)) {
      void shell.openExternal(target);
    } else {
      console.warn(`[browser/workspace] blocked navigation to: ${target}`);
    }
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    } else {
      console.warn(`[browser/workspace] denied window.open for: ${url}`);
    }
    return { action: "deny" };
  });
}

const downloadGuardedSessions = new WeakSet<Session>();

/** 默认拒绝下载（L1）；同一 session 只挂一次。 */
export function attachLocalBrowserDownloadGuard(sess: Session): void {
  if (downloadGuardedSessions.has(sess)) return;
  downloadGuardedSessions.add(sess);
  sess.on("will-download", (event) => {
    event.preventDefault();
    console.warn("[browser] download denied (L1 default)");
  });
}
