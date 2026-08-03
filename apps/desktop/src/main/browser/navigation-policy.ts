/**
 * LocalChromiumHost 导航 URL 判定（纯函数，无 electron）——可单测。
 * 挂锁见 navigation.ts。
 */

import { isWorkspaceBrowserUrl } from "./workspace-paths";

/** 空白页初始地址（未导航前 WebContents 占位）。 */
export const LOCAL_BROWSER_BLANK = "about:blank";

/**
 * `window.open` / target=_blank 分流（web 模式）。
 * - `popup`：登录类弹窗 / `window.open`（含 features）→ 同 partition 子窗
 * - `tab`：普通 `target=_blank` / 中键 → 同壳新页签
 * - `deny`：危险 scheme 或未知 disposition
 */
export type WebWindowOpenRoute = "deny" | "popup" | "tab";

/** Chromium WindowOpenDisposition（Electron HandlerDetails.disposition）。 */
export type WindowOpenDisposition =
  | "default"
  | "foreground-tab"
  | "background-tab"
  | "new-window"
  | "other"
  | string;

/**
 * 外网页模式：是否允许在本机浏览器壳内加载该 URL（顶级导航 / loadURL 前置）。
 * `about:blank` 仅用于空页占位；业务导航须为 http(s)。
 */
export function isAllowedWebBrowserUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim() === "") return false;
  const trimmed = url.trim();
  if (trimmed === LOCAL_BROWSER_BLANK || trimmed.startsWith("about:blank?")) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.toLowerCase();
  return protocol === "http:" || protocol === "https:";
}

/**
 * web 模式 `setWindowOpenHandler` 分流决策（纯函数）。
 * 空 URL 视为 `about:blank`（OAuth 常先开空白再导航）。
 */
export function resolveWebWindowOpenRoute(input: {
  url: string;
  disposition: WindowOpenDisposition;
}): WebWindowOpenRoute {
  const raw = typeof input.url === "string" ? input.url.trim() : "";
  const url = raw === "" ? LOCAL_BROWSER_BLANK : raw;
  if (!isAllowedWebBrowserUrl(url)) return "deny";

  const d = input.disposition;
  if (d === "foreground-tab" || d === "background-tab") return "tab";
  // new-window / default / other：window.open（含 features）与 shift-click 等 → 子窗
  if (d === "new-window" || d === "default" || d === "other" || !d) {
    return "popup";
  }
  return "deny";
}

/** 从 window.open features 解析子窗尺寸（缺省 520×720）。 */
export function parseWindowOpenFeatures(features: string | undefined): {
  width: number;
  height: number;
  x?: number;
  y?: number;
} {
  const defaults = { width: 520, height: 720 };
  if (typeof features !== "string" || !features.trim()) return defaults;
  const get = (key: string): number | undefined => {
    const m = features.match(
      new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*(\\d+)`, "i"),
    );
    if (!m?.[1]) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const width = get("width") ?? defaults.width;
  const height = get("height") ?? defaults.height;
  const x = get("left") ?? get("screenx");
  const y = get("top") ?? get("screeny");
  return {
    width: Math.min(Math.max(width, 200), 2400),
    height: Math.min(Math.max(height, 200), 1600),
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
  };
}

/**
 * 工作区 HTML 模式：仅放行 `workspace://` 与空页占位（相对页在同 scheme 内跳转）。
 * 不放行 http(s) 顶级进同 partition（外链由 navigation 锁转 shell / 拒）。
 */
export function isAllowedWorkspaceBrowserUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim() === "") return false;
  const trimmed = url.trim();
  if (trimmed === LOCAL_BROWSER_BLANK || trimmed.startsWith("about:blank?")) {
    return true;
  }
  return isWorkspaceBrowserUrl(trimmed);
}

/**
 * 任一模式允许的壳内 URL（策略测 / 兼容旧名）。
 * = 外网页 http(s)|blank ∪ 工作区 workspace://|blank。
 */
export function isAllowedLocalBrowserUrl(url: string): boolean {
  return isAllowedWebBrowserUrl(url) || isWorkspaceBrowserUrl(url);
}

/**
 * Bridge navigate 入参 → 页模式（纯函数）。
 * ``null`` = 不可导航（非 http(s)/workspace://）。
 */
export function resolveBridgeNavigateKind(
  url: string,
): "web" | "workspace" | null {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed || !isNavigableLocalBrowserUrl(trimmed)) return null;
  return isWorkspaceBrowserUrl(trimmed) ? "workspace" : "web";
}

/**
 * 用户地址栏 / Bridge navigate 入参：http(s) 或 workspace://（不含 about:blank）。
 */
export function isNavigableLocalBrowserUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim() === "") return false;
  if (isWorkspaceBrowserUrl(url.trim())) return true;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  const protocol = parsed.protocol.toLowerCase();
  return protocol === "http:" || protocol === "https:";
}
