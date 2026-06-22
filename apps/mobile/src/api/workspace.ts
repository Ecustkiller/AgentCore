// Workspace file REST for the mobile client (前端技术与架构 §七 · 云端文件浏览).
//
// The conversation's cloud workspace, read over the same endpoints the desktop uses
// (api/routes/conversations.py). The list endpoint only does「顶层」(glob *) or「整树」
// (glob **/*) — there is no per-subdirectory listing — so the mobile browser fetches the
// whole tree once (recursive) and navigates it in memory: one round-trip, instant folder
// nav. Download needs the Bearer header, so it goes through apiFetch → Blob (an <a href>
// can't carry Authorization). Types are a hand-written subset of the backend schema
// (schemas.py WorkspaceFileEntry), matching the skeleton convention in conversations.ts.
import { apiFetch } from "@/api/client";

/** One entry in a workspace listing — workspace-relative POSIX path + kind. */
export interface WorkspaceFileEntry {
  path: string;
  is_dir: boolean;
}

/** A folder/file node in the navigable tree (derived from the flat listing). */
export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
}

/** The conversation's whole workspace tree as a flat recursive listing. A 裸聊 (no
 *  folder) workspace has no files yet and returns an empty list rather than erroring. */
export async function listWorkspaceFiles(
  conversationId: string,
): Promise<WorkspaceFileEntry[]> {
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/workspace/files?recursive=true`,
  );
  if (!res.ok) throw new Error(`加载文件列表失败 (${res.status})`);
  const data = (await res.json()) as { data: WorkspaceFileEntry[] };
  return data.data;
}

/** Result of a workspace upload (mirrors backend UploadFileResponse). */
export interface UploadedFile {
  path: string;
  size_bytes: number;
}

/** Upload (create/overwrite) a file at `path` from raw bytes — same PUT the desktop uses.
 *  Uploading into a 裸聊 promotes it into a folder workspace first (文件夹即工作区). The
 *  '/' separators are preserved for the {path:path} route; segments are percent-encoded. */
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

/** A downloaded file's bytes plus the name to save it as and its resolved type. */
export interface DownloadedFile {
  blob: Blob;
  filename: string;
  contentType: string;
}

/** Fetch one file's raw bytes (Bearer-authenticated). Each path segment is
 *  percent-encoded while the '/' separators are preserved for the {path:path} route. */
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

/** Group a flat recursive listing into `dir → sorted children`, deriving intermediate
 *  directories from path segments so folders always appear even if the listing was
 *  capped or returned files only. Dirs sort before files, then alphabetical. The key
 *  "" is the root; a child's `path` is its full workspace-relative path. */
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
      // Every segment but the last is necessarily a directory; the last takes the
      // entry's own kind. A path seen as both (derived dir + explicit entry) stays a dir.
      const isDir = i < segs.length - 1 ? true : entry.is_dir;
      const here = bucket(parent);
      const prev = here.get(name);
      if (!prev) here.set(name, { name, path: full, isDir });
      else if (isDir) prev.isDir = true;
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
