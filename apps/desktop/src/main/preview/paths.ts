/**
 * `preview://` 协议的**纯逻辑**：分区/协议常量、路径守卫、MIME 推断、URL 构造、CSP。
 *
 * 刻意不引 electron —— 协议处理器（protocol.ts）在此之上组合「会话 + Bearer 鉴权 +
 * 流式返回」，把可测的安全不变量（路径穿越防护 / preview URL 构造 / 后端寻址）留在这层，
 * 单测无需 mock electron。
 */

import type { PreviewBounds } from "@shared/preview-contract";
import { normalizePreviewPath } from "@shared/preview-path";

export const PREVIEW_SCHEME = "preview";
export { normalizePreviewPath };

/**
 * 预览宿主子窗口所用的**非持久独立分区**（名字不带 `persist:` → 内存态、随进程退出清空）。
 * 绝不能是 defaultSession，也绝不能持久化——它绝不该触及应用登录 cookie（token 只在主进程
 * 经 Bearer 代理，见 protocol.ts），也不给 AI 生成页面留任何跨次残留。
 */
export const PREVIEW_PARTITION = "agentcore-preview";

/**
 * 预览响应的独立 CSP：预览宿主是 sandbox + 独立分区的隔离子窗口（无 cookie / 无 token /
 * 无 preload / 无应用数据），故这里放开「内联 + 同源脚本样式」让 AI 生成页面（多为内联 JS）
 * 完整跑起来，并放行 https:/data:/blob: 子资源（字体 / CDN / 图片 / 媒体）。隔离窗口本身是
 * 安全边界，CSP 是纵深收紧：object-src 'none'、base-uri 'none' 关掉最危险的原语，
 * frame-ancestors 'self' 只允许同源自我内嵌（多文件页可 iframe 自己的相对页）。
 */
export const PREVIEW_CSP = [
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
 * 构造要在预览子窗口里加载的 `preview://` URL：会话 id 作 host（标准 scheme 下 host 被
 * Chromium 小写化——会话 id 恒为小写 UUID，见 crypto.randomUUID），路径逐段编码。
 */
export function buildPreviewUrl(conversationId: string, path: string): string {
  const host = conversationId.trim().toLowerCase();
  const rel = normalizePreviewPath(path);
  const encoded = rel ? encodeRelPath(rel) : "";
  return `${PREVIEW_SCHEME}://${host}/${encoded}`;
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
 * 校验并归一化内嵌预览的占位 bounds（来自 renderer，仅可能被攻破的 renderer 送畸形值）：
 * 四字段须为有限数字，取整（`WebContentsView.setBounds` 用整数 DIP），宽高钳非负。任一
 * 不满足返回 null（IPC 边界据此拒绝、embed 层据此跳过）。纯逻辑、无 electron 依赖、可单测。
 */
export function normalizePreviewBounds(value: unknown): PreviewBounds | null {
  if (typeof value !== "object" || value === null) return null;
  const b = value as Record<string, unknown>;
  const { x, y, width, height } = b;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height)),
  };
}
