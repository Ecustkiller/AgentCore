import {
  ApiError,
  BASE_URL,
  NetworkError,
  api,
  tryRefresh,
} from "@/services/api";

/** Encode a workspace-relative path for the `{path:path}` route (keep slashes). */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

const filesBase = (conversationId: string): string =>
  `${BASE_URL}/v1/conversations/${conversationId}/workspace/files`;

/**
 * Fetch with the app's cookie auth + refresh-once policy, for the raw-bytes
 * workspace endpoints (upload/download/zip) that bypass the JSON `api` helper.
 * Mirrors `api.request`'s 401→refresh→replay so a stale access token doesn't
 * surface as a spurious failure.
 */
async function authedFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "include", ...init });
    if (res.status === 401 && (await tryRefresh())) {
      res = await fetch(url, { credentials: "include", ...init });
    }
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res;
}

/** Save a blob to disk via an object-URL anchor (Electron renderer, no IPC). */
function saveBlob(blob: Blob, filename: string): void {
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

// --- Files (bring files in / take results out: 文件进出) ---

export interface WorkspaceFile {
  /** Workspace-relative POSIX path. */
  path: string;
  isDir: boolean;
}

/** List the conversation's workspace entries (recursive POSIX paths). */
export async function listWorkspaceFiles(
  conversationId: string,
  recursive = true,
): Promise<WorkspaceFile[]> {
  const res = await api.get<{ data: { path: string; is_dir: boolean }[] }>(
    `/v1/conversations/${conversationId}/workspace/files?recursive=${recursive}`,
  );
  return res.data.map((e) => ({ path: e.path, isDir: e.is_dir }));
}

/** Upload (create/overwrite) a workspace file from raw bytes. */
export async function uploadWorkspaceFile(
  conversationId: string,
  path: string,
  body: Blob,
): Promise<void> {
  await authedFetch(`${filesBase(conversationId)}/${encodePath(path)}`, {
    method: "PUT",
    body,
  });
}

/** Delete a workspace file or directory (directories go recursively). */
export async function deleteWorkspaceFile(
  conversationId: string,
  path: string,
): Promise<void> {
  await api.delete(
    `/v1/conversations/${conversationId}/workspace/files/${encodePath(path)}`,
  );
}

/** Move/rename a workspace file or directory (`AlreadyExists` → 422). */
export async function moveWorkspaceFile(
  conversationId: string,
  src: string,
  dst: string,
): Promise<void> {
  await api.post(`/v1/conversations/${conversationId}/workspace/move`, {
    src,
    dst,
  });
}

/** Create a workspace directory (parents created; `AlreadyExists` → 422). */
export async function createWorkspaceDir(
  conversationId: string,
  path: string,
): Promise<void> {
  await api.post(`/v1/conversations/${conversationId}/workspace/dirs`, {
    path,
  });
}

/**
 * Download a file from a conversation's workspace and save it via the browser.
 *
 * The file API is JSON-less (raw bytes), so this fetches directly (reusing the
 * shared cookie auth + refresh-once) and triggers a save through an object-URL
 * anchor. Backs both the resident-attachment chip (附件驻留) and the workspace
 * panel's per-file download.
 */
export async function downloadWorkspaceFile(
  conversationId: string,
  workspacePath: string,
  filename: string,
): Promise<void> {
  const res = await authedFetch(
    `${filesBase(conversationId)}/${encodePath(workspacePath)}`,
  );
  saveBlob(await res.blob(), filename);
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
 * Read a workspace file for read-only in-panel preview.
 *
 * The file API has no range support, so the body is fetched whole; the
 * `content-length` header short-circuits oversized files before reading. Binary
 * content is detected by a null byte or a high UTF-8 replacement-char ratio and
 * surfaced as a download-only result rather than rendering garbage.
 */
export async function readWorkspaceFile(
  conversationId: string,
  path: string,
): Promise<FilePreview> {
  const res = await authedFetch(
    `${filesBase(conversationId)}/${encodePath(path)}`,
  );
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

// --- Snapshots (axis-3 persistence: backup / kept versions / download) ---

export interface WorkspaceSnapshot {
  snapshotId: string;
  /** A user-pinned name (手动留版本), or null for an automatic post-turn backup. */
  label: string | null;
  createdAt: string;
  sizeBytes: number;
}

interface BackendSnapshot {
  snapshot_id: string;
  label: string | null;
  created_at: string;
  size_bytes: number;
}

const toSnapshot = (s: BackendSnapshot): WorkspaceSnapshot => ({
  snapshotId: s.snapshot_id,
  label: s.label,
  createdAt: s.created_at,
  sizeBytes: s.size_bytes,
});

/** List the conversation's workspace snapshots (newest first). */
export async function listSnapshots(
  conversationId: string,
): Promise<WorkspaceSnapshot[]> {
  const res = await api.get<{ data: BackendSnapshot[] }>(
    `/v1/conversations/${conversationId}/snapshots`,
  );
  return res.data.map(toSnapshot);
}

/** Take a manual snapshot; a non-empty `label` keeps it as a named version. */
export async function createSnapshot(
  conversationId: string,
  label?: string,
): Promise<WorkspaceSnapshot> {
  const res = await api.post<BackendSnapshot>(
    `/v1/conversations/${conversationId}/snapshots`,
    { label: label?.trim() || null },
  );
  return toSnapshot(res);
}

/** Restore the workspace to a snapshot (overwrites current files). */
export async function restoreSnapshot(
  conversationId: string,
  snapshotId: string,
): Promise<void> {
  await api.post(
    `/v1/conversations/${conversationId}/snapshots/${snapshotId}/restore`,
  );
}

/** Download a snapshot's zip archive and save it via the browser. */
export async function downloadSnapshot(
  conversationId: string,
  snapshotId: string,
): Promise<void> {
  const res = await authedFetch(
    `${BASE_URL}/v1/conversations/${conversationId}/snapshots/${snapshotId}/download`,
  );
  saveBlob(await res.blob(), `workspace-${snapshotId}.zip`);
}
