/**
 * 本机浏览器「工作区 HTML」协议的**纯逻辑**（L1b 第二非持久 partition）。
 *
 * 与外网页 {@link browserPartitionFor} **分立**：不共用 session，防 cookie 串到产物页。
 * 路径守卫 / MIME / CSP 为安全不变量（不得削弱）；本文件持有 scheme + partition + 寻址。
 *
 * 刻意不引 electron —— 协议处理器（workspace-protocol.ts）在此之上组合会话 + Bearer，
 * 把可测不变量留在本层，单测无需 mock electron。
 */

import { normalizePreviewPath } from "@shared/preview-path";
import {
  WORKSPACE_SCHEME,
  resolveWorkspaceProtocolRequest,
} from "@shared/workspace-browser-url";
import { normalizeBrowserConversationId } from "./paths";

export {
  resolveWorkspaceProtocolRequest,
  WORKSPACE_SCHEME,
  normalizePreviewPath,
};

/** 工作区 partition 前缀（完整键 = {@link workspacePartitionFor}）。 */
export const WORKSPACE_PARTITION_PREFIX = "agentcore-browser-workspace";

/**
 * 工作区 HTML 宿主所用的**非持久独立分区**（无 `persist:`）。
 * 键：`agentcore-browser-workspace:conv:{conversationId}`。
 * ≠ 外网 `agentcore-browser:conv:…`。
 */
export function workspacePartitionFor(conversationId: string): string {
  const cid = normalizeBrowserConversationId(conversationId);
  if (!cid) {
    throw new Error("workspacePartitionFor: conversationId required");
  }
  return `${WORKSPACE_PARTITION_PREFIX}:conv:${cid}`;
}

/**
 * 工作区响应 CSP：sandbox + 独立分区已是边界，此处放开内联脚本样式让 AI 生成页跑起来，
 * 并放行 https:/data:/blob: 子资源；object-src / base-uri 关掉危险原语。
 */
export const WORKSPACE_CSP = [
  "default-src 'self' https: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "media-src 'self' https: data: blob:",
  "connect-src 'self' https: data:",
  "worker-src 'self' blob:",
  "frame-src 'self' https: data:",
  "child-src 'self' https: data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self' https:",
  "frame-ancestors 'self'",
].join("; ");

/** 逐段 encodeURIComponent、保留 `/`（用于把相对路径拼进后端 `{path:path}` 路由）。 */
function encodeRelPath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * 后端「会话工作区文件」端点的**相对**路径（与渲染层 services/workspace 同形：
 * `/v1/conversations/{id}/workspace/files/{path}`）。由 auth-client.bearerFetch 拼上
 * 构建期烘焙的 API base 后发起 Bearer 代理请求。
 */
export function workspaceFilePath(
  conversationId: string,
  relPath: string,
): string {
  const id = encodeURIComponent(conversationId);
  return `/v1/conversations/${id}/workspace/files/${encodeRelPath(relPath)}`;
}

/** 常见 web 资源类型的扩展名 → MIME 映射（未知回退 application/octet-stream）。 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  csv: "text/csv; charset=utf-8",
};

/** 按扩展名推断 MIME（响应头用；配合 X-Content-Type-Options: nosniff）。 */
export function mimeForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot < 0 || dot < slash) return "application/octet-stream";
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * 构造要在本机浏览器工作区页里加载的 `workspace://` URL。
 * 会话 id 作 host（小写 UUID）；路径经 {@link normalizePreviewPath} 守卫后逐段编码。
 */
export function buildWorkspaceUrl(
  conversationId: string,
  path: string,
): string {
  const host = normalizeBrowserConversationId(conversationId);
  const rel = normalizePreviewPath(path);
  const encoded = rel ? rel.split("/").map(encodeURIComponent).join("/") : "";
  return `${WORKSPACE_SCHEME}://${host}/${encoded}`;
}

/** 是否本机浏览器允许的工作区协议 URL。 */
export function isWorkspaceBrowserUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim() === "") return false;
  try {
    return (
      new URL(url.trim()).protocol.toLowerCase() === `${WORKSPACE_SCHEME}:`
    );
  } catch {
    return false;
  }
}
