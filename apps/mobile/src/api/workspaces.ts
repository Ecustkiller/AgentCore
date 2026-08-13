// First-class workspace REST for the mobile 文件 tab (跨工作区文件总览).
//
// Reads workspace endpoints by ws_id (`folder:<id>`). Cloud-only on mobile (local
// workspaces are desktop-only). REST wire types track OpenAPI; `WorkspaceSummary`
// is the mobile camelCase view (mirrors desktop `WorkspaceInfo`).
import { apiFetch } from "@/api/client";
import {
  type DownloadedFile,
  type WorkspaceEditDoc,
  type WorkspaceListing,
  type WorkspaceTrashEntry,
  type WorkspaceWriteInput,
  type WorkspaceWriteOutcome,
  editWriteBody,
  encodeWorkspacePath,
  toEditDoc,
  toTrashEntry,
  toWriteOutcome,
  workspaceApiError,
} from "@/api/workspace";
import { workspaceFileDownloadError } from "@/lib/fileDownloadError";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

type WorkspaceListResponse = Schemas["WorkspaceListResponse"];
type WorkspaceFileListResponse = Schemas["WorkspaceFileListResponse"];
type WorkspaceEditDocWire = Schemas["WorkspaceEditDoc"];
type WorkspaceWriteResultWire = Schemas["WorkspaceWriteResult"];
type TrashListResponse = Schemas["TrashListResponse"];

/**
 * One of the user's workspaces (a project/folder), as listed for the 文件 tab.
 * CamelCase client projection of OpenAPI `WorkspaceSummary` (M17 exemption:
 * OpenAPI wire is snake_case; mobile 文件 tab uses camelCase like desktop WorkspaceInfo).
 */
export interface WorkspaceSummary {
  wsId: string;
  name: string;
  location: "cloud" | "local";
  hasFiles: boolean;
}

/** Enumerate the user's workspaces (cloud + local). Caller filters to cloud on mobile. */
export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const res = await apiFetch("/v1/workspaces");
  if (!res.ok) throw new Error(`加载工作区失败 (${res.status})`);
  const data = (await res.json()) as WorkspaceListResponse;
  return data.data.map((w) => ({
    wsId: w.ws_id,
    name: w.name,
    location: w.location,
    hasFiles: w.has_files,
  }));
}

const wsBase = (wsId: string): string =>
  `/v1/workspaces/${encodeURIComponent(wsId)}`;

const wsFileUrl = (wsId: string, path: string): string =>
  `${wsBase(wsId)}/files/${encodeWorkspacePath(path)}`;

const wsEditUrl = (wsId: string, path: string): string =>
  `${wsBase(wsId)}/edit/${encodeWorkspacePath(path)}`;

/** A cloud workspace's whole tree as a flat recursive listing. */
export async function listWorkspaceFilesByWs(
  wsId: string,
): Promise<WorkspaceListing> {
  const res = await apiFetch(`${wsBase(wsId)}/files?recursive=true`);
  if (!res.ok) throw new Error(`加载文件列表失败 (${res.status})`);
  const data = (await res.json()) as WorkspaceFileListResponse;
  return { entries: data.data, truncated: data.truncated ?? false };
}

/** Fetch one file's raw bytes (Bearer-authenticated). */
export async function downloadWorkspaceFileByWs(
  wsId: string,
  path: string,
): Promise<DownloadedFile> {
  const res = await apiFetch(wsFileUrl(wsId, path));
  if (!res.ok) {
    throw new Error(
      workspaceFileDownloadError(res.status, { scope: "workspace" }),
    );
  }
  const blob = await res.blob();
  return {
    blob,
    filename: path.split("/").pop() || "download",
    contentType:
      res.headers.get("Content-Type") ||
      blob.type ||
      "application/octet-stream",
  };
}

/** Upload (create/overwrite) a file at `path` from raw bytes. */
export async function uploadWorkspaceFileByWs(
  wsId: string,
  path: string,
  file: Blob,
): Promise<void> {
  const res = await apiFetch(wsFileUrl(wsId, path), {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw await workspaceApiError(res, "上传失败");
}

// --- Writes (改名 / 移动 / 删除 / 新建文件夹 / 文本编辑) ---
//
// 云工作区可写。工作区**生命周期**（新建/改名/删除工作区、绑定本机文件夹）不在这里：
// 那是桌面的活，手机只写工作区**里面**的文件。

/** Move or rename one entry (改名 = 同目录内的移动；后端拒绝覆盖同名). */
export async function moveWorkspaceEntryByWs(
  wsId: string,
  src: string,
  dst: string,
): Promise<void> {
  const res = await apiFetch(`${wsBase(wsId)}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ src, dst }),
  });
  if (!res.ok) throw await workspaceApiError(res, "移动失败");
}

/** Soft-delete one file/directory into `AgentCore/trash`（可在软删区还原）. */
export async function deleteWorkspaceEntryByWs(
  wsId: string,
  path: string,
): Promise<void> {
  const res = await apiFetch(wsFileUrl(wsId, path), { method: "DELETE" });
  if (!res.ok) throw await workspaceApiError(res, "删除失败");
}

/** Create a directory at `path`. */
export async function createWorkspaceDirByWs(
  wsId: string,
  path: string,
): Promise<void> {
  const res = await apiFetch(`${wsBase(wsId)}/dirs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw await workspaceApiError(res, "新建文件夹失败");
}

/** Read a text file for editing: whole text + mtime CAS baseline. */
export async function readWorkspaceFileForEditByWs(
  wsId: string,
  path: string,
): Promise<WorkspaceEditDoc> {
  const res = await apiFetch(wsEditUrl(wsId, path));
  if (!res.ok) throw await workspaceApiError(res, "打开编辑失败");
  return toEditDoc((await res.json()) as WorkspaceEditDocWire);
}

/** Conditionally write editor text back (mtime CAS; `conflict` = 未写入). */
export async function writeWorkspaceFileTextByWs(
  wsId: string,
  path: string,
  input: WorkspaceWriteInput,
): Promise<WorkspaceWriteOutcome> {
  const res = await apiFetch(wsEditUrl(wsId, path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: editWriteBody(input),
  });
  if (!res.ok) throw await workspaceApiError(res, "保存失败");
  return toWriteOutcome((await res.json()) as WorkspaceWriteResultWire);
}

// --- AgentCore/trash (同一套软删区，只是按 ws_id 寻址) ---

/** List `AgentCore/trash` for a cloud workspace (newest first). */
export async function listWorkspaceTrashByWs(
  wsId: string,
): Promise<{ entries: WorkspaceTrashEntry[]; retentionDays: number }> {
  const res = await apiFetch(`${wsBase(wsId)}/trash`);
  if (!res.ok) throw new Error(`加载软删区失败 (${res.status})`);
  const data = (await res.json()) as TrashListResponse;
  return {
    entries: data.data.map(toTrashEntry),
    retentionDays: data.retention_days,
  };
}

/** Restore one soft-deleted entry to its original relative path. */
export async function restoreWorkspaceTrashByWs(
  wsId: string,
  entryId: string,
): Promise<void> {
  const res = await apiFetch(
    `${wsBase(wsId)}/trash/${encodeURIComponent(entryId)}/restore`,
    { method: "POST" },
  );
  if (!res.ok) throw await workspaceApiError(res, "还原失败");
}
