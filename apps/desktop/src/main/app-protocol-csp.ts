/**
 * app:// 协议 pathname 解码与 CSP connect-src 构造（纯逻辑，无 Electron）。
 *
 * 主进程 index.ts 在 registerAppProtocol / CONTENT_SECURITY_POLICY 使用；
 * 单测覆盖畸形 % 编码与 API 源解析失败时的 fail-closed 行为。
 */

/** 解析构建期烘焙的 API 基址为 origin；失败返回空串（调用方按收紧策略处理）。 */
export function apiOriginForCsp(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    return "";
  }
}

/**
 * connect-src 指令。有后端源时钉死「自己 + 该源（及同源 ws）」；
 * 源不可解析时【失败收紧】到 `'self'`——与 img-src 失败退化对称，禁止放开 https:/http:/ws:/wss:。
 */
export function connectSrcForCsp(apiOrigin: string): string {
  if (apiOrigin) {
    return `connect-src 'self' ${apiOrigin} ${apiOrigin.replace(/^http/, "ws")}`;
  }
  return "connect-src 'self'";
}

/**
 * frame-src：面板内 PDF 用 iframe 加载 blob:/data:（字节已在页内，不引入网络取框面）。
 * 刻意不含 https: / * —— 禁随意放宽；object-src 仍保持 none。
 */
export function frameSrcForCsp(): string {
  return "frame-src 'self' blob: data:";
}

/**
 * 把 app:// pathname 解成相对 RENDERER_ROOT 的路径。
 * `/` → `index.html`；畸形百分号编码 → `null`（调用方应回 400，禁止 URIError 冒泡）。
 */
export function decodeAppRelativePath(pathname: string): string | null {
  if (pathname === "/") return "index.html";
  try {
    return decodeURIComponent(pathname.slice(1));
  } catch {
    return null;
  }
}
