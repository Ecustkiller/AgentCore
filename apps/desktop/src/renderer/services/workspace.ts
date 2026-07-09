import { BASE_URL, api } from "@/services/api";
import {
  type FilePreview,
  type WorkspaceEditDoc,
  type WorkspaceFile,
  type WorkspaceWriteOutcome,
  authedFetch,
  decodePreviewResponse,
  encodePath,
  saveBlob,
} from "@/services/workspaceHttp";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

/**
 * Conversation-scoped workspace REST client — the per-conversation alias used by
 * the chat panel: every op hits `/v1/conversations/{id}/workspace/...`. The file
 * hub instead addresses workspaces by id via `services/workspaces`; both share the
 * neutral primitives in `services/workspaceHttp` and hit the same server service
 * layer, only the addressing differs. Snapshots live here because they are a
 * conversation-scoped concern with no ws-id counterpart.
 */

const filesBase = (conversationId: string): string =>
  `${BASE_URL}/v1/conversations/${conversationId}/workspace/files`;

// --- Files (bring files in / take results out: 文件进出) ---

/** List the conversation's workspace entries (recursive POSIX paths). */
export async function listWorkspaceFiles(
  conversationId: string,
  recursive = true,
): Promise<WorkspaceFile[]> {
  const res = await api.get<Schemas["WorkspaceFileListResponse"]>(
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

/** Read a conversation-workspace file for read-only in-panel preview. */
export async function readWorkspaceFile(
  conversationId: string,
  path: string,
): Promise<FilePreview> {
  const res = await authedFetch(
    `${filesBase(conversationId)}/${encodePath(path)}`,
  );
  return decodePreviewResponse(res);
}

// --- Edit (源无关编辑契约的云端实现: full text + mtime CAS) ---

/**
 * Read a conversation-workspace file for **editing** — full text (never truncated,
 * unlike preview) + the mtime baseline a later save does its CAS against. The
 * editable counterpart of {@link readWorkspaceFile}.
 */
export async function readWorkspaceFileForEdit(
  conversationId: string,
  path: string,
): Promise<WorkspaceEditDoc> {
  const res = await api.get<Schemas["WorkspaceEditDoc"]>(
    `/v1/conversations/${conversationId}/workspace/edit/${encodePath(path)}`,
  );
  return { text: res.text, mtimeMs: res.mtime_ms, eol: res.eol };
}

/**
 * Conditionally write editor text back (mtime CAS). A `conflict` (disk changed
 * since `baselineMtimeMs`, e.g. an Agent turn wrote it) returns `ok:false` with the
 * disk mtime instead of clobbering — never a blind overwrite.
 */
export async function writeWorkspaceFileText(
  conversationId: string,
  path: string,
  input: { content: string; eol: "lf" | "crlf"; baselineMtimeMs: number },
): Promise<WorkspaceWriteOutcome> {
  const res = await api.put<Schemas["WorkspaceWriteResult"]>(
    `/v1/conversations/${conversationId}/workspace/edit/${encodePath(path)}`,
    {
      content: input.content,
      eol: input.eol,
      baseline_mtime_ms: input.baselineMtimeMs,
    } satisfies Schemas["WorkspaceWriteRequest"],
  );
  return { ok: res.ok, mtimeMs: res.mtime_ms, conflict: res.conflict };
}

// --- Snapshots (axis-3 persistence: backup / kept versions / download) ---

export interface WorkspaceSnapshot {
  snapshotId: string;
  /** A user-pinned name (手动留版本), or null for an automatic post-turn backup. */
  label: string | null;
  createdAt: string;
  sizeBytes: number;
}

/** Server snapshot payload (`/snapshots`), generated from OpenAPI. */
type BackendSnapshot = Schemas["SnapshotSummary"];

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
  const res = await api.get<Schemas["SnapshotListResponse"]>(
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

/** Snapshot current cloud workspace files and download as a zip (产物导出). */
export async function exportWorkspaceZip(conversationId: string): Promise<void> {
  const snap = await createSnapshot(conversationId, "导出");
  await downloadSnapshot(conversationId, snap.snapshotId);
}
