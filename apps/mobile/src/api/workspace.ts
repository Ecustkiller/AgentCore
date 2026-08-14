// Workspace file REST for the mobile client (前端技术与架构 §七 · 云端文件浏览).
//
// The conversation's cloud workspace over the same endpoints the desktop uses.
// The mobile browser fetches the whole tree once (recursive) and navigates in memory.
// Download needs the Bearer header via apiFetch. REST DTOs track OpenAPI.
import { apiFetch } from "@/api/client";
import { workspaceFileDownloadError } from "@/lib/fileDownloadError";
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

/** Line ending the backend round-trips through an edit (never guessed client-side). */
export type WorkspaceEol = "lf" | "crlf";

/**
 * A text file opened for editing: whole text + the mtime CAS baseline.
 *
 * The download used for preview is capped and carries no version, so a save must
 * start from here — `mtimeMs` is what makes the write conditional.
 */
export interface WorkspaceEditDoc {
  text: string;
  mtimeMs: number;
  eol: WorkspaceEol;
}

/** Editor text plus the baseline it was read at (the CAS precondition). */
export interface WorkspaceWriteInput {
  content: string;
  baselineMtimeMs: number;
  eol: WorkspaceEol;
}

/**
 * Outcome of a conditional write.
 *
 * `conflict` means the file changed since the baseline (an Agent turn, another
 * device) and **nothing was written**. `mtimeMs` is then the current cloud
 * version, so an explicit「仍然覆盖」can re-write with it as the new baseline.
 */
export interface WorkspaceWriteOutcome {
  ok: boolean;
  mtimeMs: number;
  conflict: boolean;
}

type WorkspaceEditDocWire = Schemas["WorkspaceEditDoc"];
type WorkspaceWriteResultWire = Schemas["WorkspaceWriteResult"];

export const toEditDoc = (d: WorkspaceEditDocWire): WorkspaceEditDoc => ({
  text: d.text,
  mtimeMs: d.mtime_ms,
  eol: d.eol,
});

export const toWriteOutcome = (
  r: WorkspaceWriteResultWire,
): WorkspaceWriteOutcome => ({
  ok: r.ok,
  mtimeMs: r.mtime_ms,
  conflict: r.conflict,
});

export const editWriteBody = (input: WorkspaceWriteInput): string =>
  JSON.stringify({
    content: input.content,
    baseline_mtime_ms: input.baselineMtimeMs,
    eol: input.eol,
  });

/**
 * The backend's own `{error:{message}}` when it sent one, else `<fallback> (status)`.
 *
 * Write refusals are the interesting ones (已存在同名文件 / 路径非法 / 只读成员),
 * and the server already words them for users — repeating a bare status code
 * would throw that away.
 */
export async function workspaceApiError(
  res: Response,
  fallback: string,
): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) return new Error(body.error.message);
  } catch {
    /* non-JSON error body → keep the status fallback */
  }
  return new Error(`${fallback} (${res.status})`);
}

/**
 * 一次工作区列举的结果：条目 + 是否被服务端条目上限截断。
 *
 * `truncated` 必须一路带到界面——被悄悄砍掉的树在用户眼里就是「我的文件没了」。
 */
export interface WorkspaceListing {
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}

/** The conversation's whole workspace tree as a flat recursive listing. */
export async function listWorkspaceFiles(
  conversationId: string,
): Promise<WorkspaceListing> {
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/workspace/files?recursive=true`,
  );
  if (!res.ok) throw new Error(`加载文件列表失败 (${res.status})`);
  const data = (await res.json()) as WorkspaceFileListResponse;
  return { entries: data.data, truncated: data.truncated ?? false };
}

/** Percent-encode each segment, keeping `/` as the path separator. */
export const encodeWorkspacePath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

/** Upload (create/overwrite) a file at `path` from raw bytes. */
export async function uploadWorkspaceFile(
  conversationId: string,
  path: string,
  file: Blob,
): Promise<UploadedFile> {
  const encoded = encodeWorkspacePath(path);
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/workspace/files/${encoded}`,
    {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    },
  );
  if (!res.ok) throw await workspaceApiError(res, "上传失败");
  return (await res.json()) as UploadedFile;
}

/** Fetch one file's raw bytes (Bearer-authenticated). */
export async function downloadWorkspaceFile(
  conversationId: string,
  path: string,
): Promise<DownloadedFile> {
  const encoded = encodeWorkspacePath(path);
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/workspace/files/${encoded}`,
  );
  if (!res.ok) {
    throw new Error(
      workspaceFileDownloadError(res.status, { scope: "conversation" }),
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

// --- Cloud workspace writes (rename/move/delete/mkdir + CAS text edit) ---
//
// 手机可写云工作区。本地工作区的字节在用户机器上，服务端会 409 —— 调用方按绑定
// 模式决定要不要给出这些入口，别在这里分叉。
//
// URL 逐条写全、不抽 base 常量：`validate_rest_paths.py` 只认字面量，拼接出来的
// 后缀它看不见，抽了 base 反而让这些端点漏出 OpenAPI 校验。

/** Move or rename one entry (改名 = 同目录内的移动；后端拒绝覆盖同名). */
export async function moveWorkspaceEntry(
  conversationId: string,
  src: string,
  dst: string,
): Promise<void> {
  const res = await apiFetch(
    `/v1/conversations/${encodeURIComponent(conversationId)}/workspace/move`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ src, dst }),
    },
  );
  if (!res.ok) throw await workspaceApiError(res, "移动失败");
}

/** Soft-delete one file/directory into `AgentCore/trash`（可在软删区还原）. */
export async function deleteWorkspaceEntry(
  conversationId: string,
  path: string,
): Promise<void> {
  const encoded = encodeWorkspacePath(path);
  const res = await apiFetch(
    `/v1/conversations/${encodeURIComponent(conversationId)}/workspace/files/${encoded}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw await workspaceApiError(res, "删除失败");
}

/** Create a directory at `path`. */
export async function createWorkspaceDir(
  conversationId: string,
  path: string,
): Promise<void> {
  const res = await apiFetch(
    `/v1/conversations/${encodeURIComponent(conversationId)}/workspace/dirs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
  );
  if (!res.ok) throw await workspaceApiError(res, "新建文件夹失败");
}

/** Read a text file for editing: whole text + mtime CAS baseline. */
export async function readWorkspaceFileForEdit(
  conversationId: string,
  path: string,
): Promise<WorkspaceEditDoc> {
  const encoded = encodeWorkspacePath(path);
  const res = await apiFetch(
    `/v1/conversations/${encodeURIComponent(conversationId)}/workspace/edit/${encoded}`,
  );
  if (!res.ok) throw await workspaceApiError(res, "打开编辑失败");
  return toEditDoc((await res.json()) as WorkspaceEditDocWire);
}

/** Conditionally write editor text back (mtime CAS; `conflict` = 未写入). */
export async function writeWorkspaceFileText(
  conversationId: string,
  path: string,
  input: WorkspaceWriteInput,
): Promise<WorkspaceWriteOutcome> {
  const encoded = encodeWorkspacePath(path);
  const res = await apiFetch(
    `/v1/conversations/${encodeURIComponent(conversationId)}/workspace/edit/${encoded}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: editWriteBody(input),
    },
  );
  if (!res.ok) throw await workspaceApiError(res, "保存失败");
  return toWriteOutcome((await res.json()) as WorkspaceWriteResultWire);
}

/** Resolved workspace mode for a conversation (local vs cloud). */
export type WorkspaceBinding = Schemas["WorkspaceBindingResponse"];

/** Report whether this conversation's files live on a desktop local disk. */
export async function getWorkspaceBinding(
  conversationId: string,
): Promise<WorkspaceBinding> {
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/workspace/binding`,
  );
  if (!res.ok) throw new Error(`加载工作区绑定失败 (${res.status})`);
  return (await res.json()) as WorkspaceBinding;
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

export const toTrashEntry = (e: BackendTrashEntry): WorkspaceTrashEntry => ({
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

/**
 * Listing leaf → FileNode size/mtime. Null stays omitted (never `0` / epoch as a stand-in).
 * Same mapping `buildTree` uses for the listing row itself (`isLeaf`) vs synthetic parents.
 */
export function listingLeafMeta(
  entry: Pick<WorkspaceFileEntry, "size_bytes" | "mtime_ms">,
  isLeaf: boolean,
): Pick<FileNode, "sizeBytes" | "mtimeMs"> {
  return {
    sizeBytes:
      isLeaf && entry.size_bytes != null ? entry.size_bytes : undefined,
    mtimeMs: isLeaf && entry.mtime_ms != null ? entry.mtime_ms : undefined,
  };
}

/**
 * Path → leaf size/mtime from an existing workspace list.
 * Directories and rows with both fields null are omitted; callers leave the UI blank.
 */
export function fileMetaByPath(
  entries: WorkspaceFileEntry[],
): Map<string, Pick<FileNode, "sizeBytes" | "mtimeMs">> {
  const out = new Map<string, Pick<FileNode, "sizeBytes" | "mtimeMs">>();
  for (const entry of entries) {
    if (entry.is_dir) continue;
    const meta = listingLeafMeta(entry, true);
    if (meta.sizeBytes == null && meta.mtimeMs == null) continue;
    out.set(entry.path, meta);
  }
  return out;
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
      const { sizeBytes, mtimeMs } = listingLeafMeta(entry, isLeaf);
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
