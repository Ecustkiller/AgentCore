// Workspace file REST for the mobile client (前端技术与架构 §七 · 云端文件浏览).
//
// The conversation's cloud workspace over the same endpoints the desktop uses.
// The mobile browser fetches the whole tree once (recursive) and navigates in memory.
// Download needs the Bearer header via apiFetch. REST DTOs track OpenAPI.
import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";

type Schemas = components["schemas"];

export type WorkspaceFileEntry = Schemas["WorkspaceFileEntry"];
export type UploadedFile = Schemas["UploadFileResponse"];

type WorkspaceFileListResponse = Schemas["WorkspaceFileListResponse"];

/** A folder/file node in the navigable tree (derived from the flat listing). */
export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  /** Leaf entry size when known; synthetic mid-path dirs stay undefined. */
  sizeBytes?: number;
  /** Edit CAS mtime (ms); dirs may have it, synthetic mid-path dirs stay undefined. */
  mtimeMs?: number;
}

/** A downloaded file's bytes plus the name to save it as and its resolved type. */
export interface DownloadedFile {
  blob: Blob;
  filename: string;
  contentType: string;
}

/** The conversation's whole workspace tree as a flat recursive listing. */
export async function listWorkspaceFiles(
  conversationId: string,
): Promise<WorkspaceFileEntry[]> {
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/workspace/files?recursive=true`,
  );
  if (!res.ok) throw new Error(`加载文件列表失败 (${res.status})`);
  const data = (await res.json()) as WorkspaceFileListResponse;
  return data.data;
}

/** Upload (create/overwrite) a file at `path` from raw bytes. */
export async function uploadWorkspaceFile(
  conversationId: string,
  path: string,
  file: Blob,
): Promise<UploadedFile> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/workspace/files/${encoded}`,
    {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    },
  );
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
  return (await res.json()) as UploadedFile;
}

/** Fetch one file's raw bytes (Bearer-authenticated). */
export async function downloadWorkspaceFile(
  conversationId: string,
  path: string,
): Promise<DownloadedFile> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/workspace/files/${encoded}`,
  );
  if (!res.ok) throw new Error(`下载文件失败 (${res.status})`);
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

/** Restore the conversation workspace to a snapshot (overwrites current files).
 *  A2′ 整回合基线回退：覆盖工作区 overlay；手机无 Local sidecar。 */
export async function restoreSnapshot(
  conversationId: string,
  snapshotId: string,
): Promise<void> {
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`恢复快照失败 (${res.status})`);
}

// --- AgentCore/trash (cloud soft-delete restore; not OS recycle bin) ---

export interface WorkspaceTrashEntry {
  entryId: string;
  originalPath: string;
  name: string;
  isDir: boolean;
  deletedAt: string;
}

type BackendTrashEntry = Schemas["TrashEntrySummary"];
type TrashListResponse = Schemas["TrashListResponse"];

const toTrashEntry = (e: BackendTrashEntry): WorkspaceTrashEntry => ({
  entryId: e.entry_id,
  originalPath: e.original_path,
  name: e.name,
  isDir: e.is_dir,
  deletedAt: e.deleted_at,
});

/** List AgentCore/trash for a cloud conversation workspace (newest first). */
export async function listTrash(
  conversationId: string,
): Promise<{ entries: WorkspaceTrashEntry[]; retentionDays: number }> {
  const res = await apiFetch(`/v1/conversations/${conversationId}/trash`);
  if (!res.ok) throw new Error(`加载软删区失败 (${res.status})`);
  const data = (await res.json()) as TrashListResponse;
  return {
    entries: data.data.map(toTrashEntry),
    retentionDays: data.retention_days,
  };
}

/** Restore one AgentCore/trash entry to its original relative path. */
export async function restoreTrash(
  conversationId: string,
  entryId: string,
): Promise<void> {
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/trash/${encodeURIComponent(entryId)}/restore`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`还原失败 (${res.status})`);
}

/** Group a flat recursive listing into `dir → sorted children`. */
export function buildTree(
  entries: WorkspaceFileEntry[],
): Map<string, FileNode[]> {
  const byDir = new Map<string, Map<string, FileNode>>();
  const bucket = (dir: string): Map<string, FileNode> => {
    let m = byDir.get(dir);
    if (!m) {
      m = new Map();
      byDir.set(dir, m);
    }
    return m;
  };
  for (const entry of entries) {
    const segs = entry.path.split("/").filter(Boolean);
    let parent = "";
    segs.forEach((name, i) => {
      const full = parent ? `${parent}/${name}` : name;
      const isLeaf = i === segs.length - 1;
      const isDir = isLeaf ? entry.is_dir : true;
      const here = bucket(parent);
      const prev = here.get(name);
      // Only the listing leaf carries size/mtime; synthetic intermediate dirs stay bare
      // until a real dir entry for the same path arrives and merges meta.
      const sizeBytes =
        isLeaf && entry.size_bytes != null ? entry.size_bytes : undefined;
      const mtimeMs =
        isLeaf && entry.mtime_ms != null ? entry.mtime_ms : undefined;
      if (!prev) {
        here.set(name, { name, path: full, isDir, sizeBytes, mtimeMs });
      } else {
        if (isDir) prev.isDir = true;
        if (sizeBytes != null) prev.sizeBytes = sizeBytes;
        if (mtimeMs != null) prev.mtimeMs = mtimeMs;
      }
      parent = full;
    });
  }
  const out = new Map<string, FileNode[]>();
  for (const [dir, m] of byDir) {
    out.set(
      dir,
      [...m.values()].sort((a, b) =>
        a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
      ),
    );
  }
  return out;
}
