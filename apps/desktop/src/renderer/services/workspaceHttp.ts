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

/** Save a blob to disk via an object-URL anchor (Electron renderer, no IPC). */
export function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** A workspace entry (file or directory) keyed by its workspace-relative path. */
export interface WorkspaceFile {
  /** Workspace-relative POSIX path. */
  path: string;
  isDir: boolean;
}

/** Decode cap for in-panel preview; larger files are shown truncated. */
const PREVIEW_MAX_BYTES = 512 * 1024;
/** Above this, skip preview entirely (download-only) to avoid a huge transfer. */
const PREVIEW_HARD_BYTES = 5 * 1024 * 1024;

/**
 * The outcome of a preview read: decodable text (possibly truncated), or a
 * reason it can't be shown inline (binary / too big → download instead).
 */
export type FilePreview =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "binary" }
  | { kind: "too-large" };

/**
 * Decode a raw file response into an in-panel preview result.
 *
 * The file API has no range support, so the body is fetched whole; the
 * `content-length` header short-circuits oversized files before reading. Binary
 * content is detected by a null byte or a high UTF-8 replacement-char ratio and
 * surfaced as a download-only result rather than rendering garbage. Shared by both
 * the conversation-scoped and the ws-id-scoped preview reads.
 */
export async function decodePreviewResponse(
  res: Response,
): Promise<FilePreview> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > PREVIEW_HARD_BYTES) return { kind: "too-large" };

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > PREVIEW_HARD_BYTES) return { kind: "too-large" };

  const truncated = bytes.length > PREVIEW_MAX_BYTES;
  const slice = truncated ? bytes.subarray(0, PREVIEW_MAX_BYTES) : bytes;

  const probe = Math.min(slice.length, 8192);
  for (let i = 0; i < probe; i++) {
    if (slice[i] === 0) return { kind: "binary" };
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  const scan = Math.min(text.length, 4096);
  let replacements = 0;
  for (let i = 0; i < scan; i++) {
    if (text.charCodeAt(i) === 0xfffd) replacements++;
  }
  if (scan > 0 && replacements / scan > 0.1) return { kind: "binary" };

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
