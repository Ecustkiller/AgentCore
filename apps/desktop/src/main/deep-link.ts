/**
 * `nexus://` 深链解析（最后修订 2026-11-04）。
 *
 * 深链是**外部输入**：浏览器、邮件、IM 都能构造它，所以它必须按不可信数据
 * 处理。这里只把 URL 翻译成一条站内 hash 路由，绝不把原始 URL 交给 loadURL，
 * 也绝不拼进 shell / executeJavaScript。解析失败一律返回 null（fail closed），
 * 主进程就只聚焦窗口、什么都不跳转。
 *
 * 支持两种形状：
 *   nexus://open?path=%2Fconversations%2F<uuid>
 *   nexus:///conversations/<uuid>          （host 为空，路径直接当路由）
 */

export const DEEP_LINK_SCHEME = "nexus";

/** 深链能落到的站内区段。收窄前缀，避免它变成任意路由/任意 URL 的入口。 */
const ALLOWED_SEGMENTS = [
  "conversations",
  "files",
  "messages",
  "toolbox",
  "more",
  "docs",
  "tables",
  "float",
  "preview",
] as const;

/** 路由正文允许的字符：路径 + 常规 query 键值，不含 #、\、协议分隔符。 */
const ROUTE_CHARS = /^[A-Za-z0-9/_?=&.%,+:-]*$/;
const MAX_ROUTE_LENGTH = 512;

/**
 * 把一条原始深链解析成 `/...` 形式的站内路由；不合法返回 null。
 * 纯函数，安全边界由 `main/__tests__/deep-link.test.ts` 钉住。
 */
export function parseDeepLink(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  if (url.username || url.password) return null;
  // fragment 不会进入 searchParams，若放行会被静默吞掉后半截，让「看起来被拒绝」
  // 的链接实际跳到别处。有 fragment 的深链一律判非法，不做猜测。
  if (url.hash) return null;

  // 显式 path 参数优先；否则把 host+pathname 当作路由（nexus:///conversations/x）。
  const explicit = url.searchParams.get("path");
  const route = explicit ?? `${url.hostname}${url.pathname}`;
  if (!route || route.length > MAX_ROUTE_LENGTH) return null;
  if (!route.startsWith("/")) return null;
  // `//host` 是协议相对 URL 的形状；反斜杠在 Windows/Chromium 里可被当分隔符。
  if (route.startsWith("//") || route.includes("\\") || route.includes("#")) {
    return null;
  }
  if (!ROUTE_CHARS.test(route)) return null;

  const pathname = route.split("?")[0];
  if (pathname === "/" || pathname === "") return "/";
  const first = pathname.split("/").filter(Boolean)[0];
  if (
    !first ||
    !ALLOWED_SEGMENTS.includes(first as (typeof ALLOWED_SEGMENTS)[number])
  ) {
    return null;
  }
  return route;
}

/** 从进程 argv 里挑出深链（Windows 第二个实例通过命令行传 URL）。 */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  const prefix = `${DEEP_LINK_SCHEME}://`;
  return argv.find((arg) => arg.startsWith(prefix)) ?? null;
}
