// First-class workspace REST for the mobile 文件 tab (手机端布局重构 · 跨工作区文件总览).
//
// The 文件 tab browses files across ALL the user's workspaces (= folders) without first
// opening a conversation — the mobile counterpart of the desktop 文件 hub (apps/desktop …
// pages/FilesPage + services/workspaces). It reads the same first-class workspace endpoints
// (api/routes/workspaces.py), addressed by workspace id (`ws_id = "folder:<id>"`) rather than
// "through a conversation". ZERO backend change: these endpoints already exist for desktop.
//
// 减法边界: a LOCAL workspace's files live on the user's machine (reached over desktop IPC);
// the server refuses file ops on them with 409. The phone has no local FS, so the 文件 tab
// lists CLOUD workspaces only (see WorkspacesPage). Types reuse the per-conversation module's
// shapes (api/workspace.ts) since the file payloads are identical — only the addressing差.
import { apiFetch } from "@/api/client";
import type { DownloadedFile, WorkspaceFileEntry } from "@/api/workspace";

/** One of the user's workspaces (a project/folder), as listed for the 文件 tab. */
export interface WorkspaceSummary {
  wsId: string;
  name: string;
  location: "cloud" | "local";
  /** Cloud workspaces carry whether they hold any files (local ones are always true,
   *  the server can't see their files); used to mark empties in the list. */
  hasFiles: boolean;
}

interface WorkspaceListWire {
  data: {
    ws_id: string;
    name: string;
    location: "cloud" | "local";
    root_id: string | null;
    subpath: string | null;
    has_files: boolean;
  }[];
  total: number;
}

/** Enumerate the user's workspaces (cloud + local). The caller filters to cloud — local
 *  workspaces are desktop-only on mobile (see module header). */
export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const res = await apiFetch("/v1/workspaces");
  if (!res.ok) throw new Error(`加载工作区失败 (${res.status})`);
  const data = (await res.json()) as WorkspaceListWire;
  return data.data.map((w) => ({
    wsId: w.ws_id,
    name: w.name,
    location: w.location,
    hasFiles: w.has_files,
  }));
}

// The '/' separators in a path stay literal for the {path:path} route; segments are
// percent-encoded. The ws id itself is encoded once (it contains a ':' — `folder:<id>`).
const wsBase = (wsId: string): string =>
  `/v1/workspaces/${encodeURIComponent(wsId)}`;

const encodePath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

/** A cloud workspace's whole tree as a flat recursive listing (mirrors the per-conversation
 *  listWorkspaceFiles). */
export async function listWorkspaceFilesByWs(
  wsId: string,
): Promise<WorkspaceFileEntry[]> {
  const res = await apiFetch(`${wsBase(wsId)}/files?recursive=true`);
  if (!res.ok) throw new Error(`加载文件列表失败 (${res.status})`);
  const data = (await res.json()) as { data: WorkspaceFileEntry[] };
  return data.data;
}

/** Fetch one file's raw bytes (Bearer-authenticated; an <a href> can't carry the header). */
export async function downloadWorkspaceFileByWs(
  wsId: string,
  path: string,
): Promise<DownloadedFile> {
  const res = await apiFetch(`${wsBase(wsId)}/files/${encodePath(path)}`);
  if (!res.ok) throw new Error(`下载文件失败 (${res.status})`);
  const blob = await res.blob();
  return {
    blob,
    filename: path.split("/").pop() || "download",
    contentType:
      res.headers.get("Content-Type") || blob.type || "application/octet-stream",
  };
}

/** Upload (create/overwrite) a file at `path` from raw bytes (same PUT the desktop uses). */
export async function uploadWorkspaceFileByWs(
  wsId: string,
  path: string,
  file: Blob,
): Promise<void> {
  const res = await apiFetch(`${wsBase(wsId)}/files/${encodePath(path)}`, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    let message = `上传失败 (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body → keep the status fallback */
    }
    throw new Error(message);
  }
}
