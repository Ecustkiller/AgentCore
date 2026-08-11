import { hasNativeSave } from "@/lib/capabilities";
import {
  ApiError,
  NetworkError,
  getCsrfHeaders,
  tryRefresh,
} from "@/services/api";

/**
 * Neutral HTTP primitives + wire types shared by every workspace/file REST client
 * (文件中枢统一 §二). These are addressing-agnostic: the conversation-scoped client
 * (`services/workspace`), the ws-id-scoped client (`services/workspaces`), the 消息
 * chat-files client (`services/messaging`) and conversation export
 * (`services/conversations`) all build their own URLs and reuse these for the
 * cross-cutting concerns — cookie auth + refresh-once, blob save, path encoding,
 * and the binary/too-large preview decode. Kept here (not in any one scoped client)
 * so no scoped module depends on a sibling just to borrow a helper.
 */

/** Encode a workspace-relative path for a `{path:path}` route (keep slashes). */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Fetch with the app's cookie auth + refresh-once policy, for the raw-bytes
 * endpoints (upload/download/zip) that bypass the JSON `api` helper. Mirrors
 * `api.request`'s 401→refresh→replay so a stale access token doesn't surface as a
 * spurious failure.
 */
export async function authedFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const withCsrf = {
    credentials: "include" as const,
    ...init,
    headers: { ...getCsrfHeaders(method), ...init.headers },
  };
  let res: Response;
  try {
    res = await fetch(url, withCsrf);
    if (res.status === 401 && (await tryRefresh()) === "renewed") {
      res = await fetch(url, withCsrf);
    }
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res;
}

/**
 * blob: URL 的延迟回收窗口。click 后**同步** revoke 属规范竞态——下载导航按规范在
 * 异步 fetch 时才解析 blob URL entry（现代 Chromium/Firefox 于导航启动时快照、实测
 * 侥幸不炸，但这不是可依赖的保证，Safari/旧引擎行为不同）。参照 FileSaver.js 延迟
 * 回收，窗口足够任何引擎把下载启动；之后回收避免长会话累积泄漏。
 */
const REVOKE_DELAY_MS = 60_000;

/**
 * Save a blob to the user's disk — the single seam every download goes through
 * (云工作区文件 / 快照 zip / 对话导出 / IM 附件 / 图表·白板导出)。
 *
 * 桌面（Electron）：经 `fs:saveFile` IPC 交主进程弹「另存为」对话框 + 原子落盘。
 * Electron 不支持 `<a download>` + blob:（不触发 will-download，且 blob: 导航被
 * will-navigate 安全守卫拦截 → 打包端点击「无反应」的根因），主进程落盘是根治；
 * **不**放宽 will-navigate 放行 blob:。
 *
 * web（浏览器运行时）：object-URL anchor 下载，revoke 延迟到下载启动之后。
 *
 * 用户在保存对话框里取消 → 正常 resolve（主动放弃非错误，不该弹错误提示）；
 * 真实失败（写盘/IPC 错误）→ reject，由各下载入口 toast。
 */
export async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const name = filename || "download";
  if (hasNativeSave()) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await window.fsApi.saveFile(name, bytes);
    if (!result.ok && result.reason === "error") {
      throw new Error(result.message || "保存文件失败");
    }
    return;
  }
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_DELAY_MS);
  }
}

/** A workspace entry (file or directory) keyed by its workspace-relative path. */
export interface WorkspaceFile {
  /** Workspace-relative POSIX path. */
  path: string;
  isDir: boolean;
}

/**
 * In-panel text display truncate — aligned with desktop IPC `TEXT_PREVIEW_CAP`
 * (256 KiB). Cloud still fetches up to {@link PREVIEW_HARD_BYTES} then slices.
 */
const PREVIEW_MAX_BYTES = 256 * 1024;
/**
 * Cloud-only network hard cap for non-image / non-PDF preview (no Range; whole-body fetch).
 * Local IPC has no peer — intentional asymmetry.
 */
const PREVIEW_HARD_BYTES = 5 * 1024 * 1024;
/** Inline image preview cap — aligned with desktop IPC `IMAGE_PREVIEW_CAP`. */
const IMAGE_PREVIEW_CAP = 10 * 1024 * 1024;
/**
 * Inline PDF preview cap — aligned with desktop IPC `PDF_PREVIEW_CAP`（15 MiB，略高于图帽）。
 */
const PDF_PREVIEW_CAP = 15 * 1024 * 1024;

/** Ext → MIME for when the server falls back to `application/octet-stream`. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

const PDF_MIME = "application/pdf";

const OVERSIZE_IMAGE_REASON =
  "图片过大（超过 10MB），请下载或用系统默认程序打开";
const OVERSIZE_PDF_REASON = "PDF 过大（超过 15MB），请下载或用系统默认程序打开";
const BINARY_PREVIEW_REASON = "无法在面板内预览，请下载或用系统默认程序打开";

/**
 * The outcome of a preview read: decodable text (possibly truncated), an inline
 * image / PDF, or a reason it can't be shown inline (binary / too big → download).
 */
export type FilePreview =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; dataUrl: string; mime: string; size: number }
  | { kind: "pdf"; dataUrl: string; mime: string; size: number }
  | { kind: "binary"; mime?: string; size?: number; reason?: string }
  | { kind: "too-large" };

function extOfPath(path: string | undefined): string {
  if (!path) return "";
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

/** Prefer `Content-Type: image/*`; else guess from the workspace-relative path. */
function resolveImageMime(
  contentType: string | null,
  path?: string,
): string | null {
  const ct = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (ct.startsWith("image/")) return ct;
  return IMAGE_MIME_BY_EXT[extOfPath(path)] ?? null;
}

/** Prefer `Content-Type: application/pdf`; else `.pdf` path extension. */
function resolvePdfMime(
  contentType: string | null,
  path?: string,
): string | null {
  const ct = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (ct === PDF_MIME || ct === "application/x-pdf") return PDF_MIME;
  if (extOfPath(path) === ".pdf") return PDF_MIME;
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Decode a raw file response into an in-panel preview result.
 *
 * Images / PDFs use `Content-Type` / path extension → inline data URL, matching
 * local IPC. Other bodies are UTF-8–probed; NUL / high replacement ratio
 * → binary. Shared by conversation-scoped and ws-id-scoped preview reads.
 */
export async function decodePreviewResponse(
  res: Response,
  opts?: { path?: string },
): Promise<FilePreview> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  const contentType = res.headers.get("content-type");
  const imageMime = resolveImageMime(contentType, opts?.path);

  if (imageMime) {
    if (declared > IMAGE_PREVIEW_CAP) {
      return {
        kind: "binary",
        mime: imageMime,
        size: declared,
        reason: OVERSIZE_IMAGE_REASON,
      };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > IMAGE_PREVIEW_CAP) {
      return {
        kind: "binary",
        mime: imageMime,
        size: bytes.length,
        reason: OVERSIZE_IMAGE_REASON,
      };
    }
    return {
      kind: "image",
      dataUrl: `data:${imageMime};base64,${bytesToBase64(bytes)}`,
      mime: imageMime,
      size: bytes.length,
    };
  }

  const pdfMime = resolvePdfMime(contentType, opts?.path);
  if (pdfMime) {
    if (declared > PDF_PREVIEW_CAP) {
      return {
        kind: "binary",
        mime: pdfMime,
        size: declared,
        reason: OVERSIZE_PDF_REASON,
      };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > PDF_PREVIEW_CAP) {
      return {
        kind: "binary",
        mime: pdfMime,
        size: bytes.length,
        reason: OVERSIZE_PDF_REASON,
      };
    }
    return {
      kind: "pdf",
      dataUrl: `data:${pdfMime};base64,${bytesToBase64(bytes)}`,
      mime: pdfMime,
      size: bytes.length,
    };
  }

  if (declared > PREVIEW_HARD_BYTES) return { kind: "too-large" };

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > PREVIEW_HARD_BYTES) return { kind: "too-large" };

  const truncated = bytes.length > PREVIEW_MAX_BYTES;
  const slice = truncated ? bytes.subarray(0, PREVIEW_MAX_BYTES) : bytes;

  const probe = Math.min(slice.length, 8192);
  for (let i = 0; i < probe; i++) {
    if (slice[i] === 0) {
      return { kind: "binary", reason: BINARY_PREVIEW_REASON };
    }
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  const scan = Math.min(text.length, 4096);
  let replacements = 0;
  for (let i = 0; i < scan; i++) {
    if (text.charCodeAt(i) === 0xfffd) replacements++;
  }
  if (scan > 0 && replacements / scan > 0.1) {
    return { kind: "binary", reason: BINARY_PREVIEW_REASON };
  }

  return { kind: "text", text, truncated };
}

/** Full text + CAS baseline (mtime) for editing a cloud-workspace file. */
export interface WorkspaceEditDoc {
  text: string;
  mtimeMs: number;
  eol: "lf" | "crlf";
}

/** A conditional write's outcome: `ok` → new version; otherwise a conflict whose
 * `mtimeMs` is the current **disk** version (re-write with it to overwrite). */
export interface WorkspaceWriteOutcome {
  ok: boolean;
  mtimeMs: number;
  conflict: boolean;
}
