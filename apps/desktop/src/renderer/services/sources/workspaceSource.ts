import {
  type FileNode,
  type FilePreviewResult,
  type FileSource,
  baseName,
} from "@/lib/fileSource";
import {
  type FilePreview as WorkspacePreview,
  createWorkspaceDir,
  deleteWorkspaceFile,
  downloadWorkspaceFile,
  listWorkspaceFiles,
  moveWorkspaceFile,
  readWorkspaceFile,
  uploadWorkspaceFile,
} from "@/services/workspace";
import {
  wsCreateDir,
  wsDeleteFile,
  wsDownloadFile,
  wsListFileIndex,
  wsListFiles,
  wsMoveFile,
  wsReadFile,
  wsUploadFile,
} from "@/services/workspaces";

/** Map the server preview shape into the unified result (server has no image kind). */
function adaptPreview(p: WorkspacePreview): FilePreviewResult {
  if (p.kind === "text") {
    return { kind: "text", text: p.text, truncated: p.truncated };
  }
  if (p.kind === "too-large") return { kind: "too-large" };
  return { kind: "binary" };
}

/** The cloud workspace caps — shared by the conversation- and ws-id-keyed sources. */
const CLOUD_CAPS = {
  watch: false,
  transfer: true,
  edit: true,
  snapshots: true,
  handoff: true,
} as const;

/**
 * A {@link FileSource} over a conversation's server workspace (cloud mode, REST),
 * keyed by conversationId — the chat panel's source (per-conversation alias). The
 * hub addresses the same spaces by workspace id via {@link createCloudWorkspaceSource}.
 * The server lists recursively in one call, so `listTree` is the natural primitive
 * and `listDir` derives a single level from it.
 */
export function createWorkspaceSource(
  conversationId: string,
  label = "工作区",
): FileSource {
  const listTree = async (): Promise<FileNode[]> => {
    const files = await listWorkspaceFiles(conversationId, true);
    return files.map((f) => ({
      path: f.path,
      name: baseName(f.path),
      isDir: f.isDir,
    }));
  };

  return {
    id: `workspace:${conversationId}`,
    label,
    caps: CLOUD_CAPS,
    listTree,
    listDir: (dir) => oneLevel(listTree, dir),
    read: (path) => readWorkspaceFile(conversationId, path).then(adaptPreview),
    createFile: (path) =>
      uploadWorkspaceFile(conversationId, path, new Blob([])),
    mkdir: (path) => createWorkspaceDir(conversationId, path),
    move: (src, dst) => moveWorkspaceFile(conversationId, src, dst),
    delete: (path) => deleteWorkspaceFile(conversationId, path),
    writeBytes: (path, body) => uploadWorkspaceFile(conversationId, path, body),
    download: (path, filename) =>
      downloadWorkspaceFile(conversationId, path, filename),
  };
}

/**
 * A {@link FileSource} over a **cloud** workspace addressed by its workspace id
 * (`/v1/workspaces/{wsId}`, 文件中枢统一 Step 2) — the hub's source for cloud
 * projects. Identical shape to {@link createWorkspaceSource}; only the addressing
 * (ws id vs conversation id) differs. Local workspaces never use this — the hub
 * picks `LocalRootSource` (IPC) for them (§五).
 */
export function createCloudWorkspaceSource(
  wsId: string,
  label = "工作区",
): FileSource {
  const listTree = async (): Promise<FileNode[]> => {
    const files = await wsListFiles(wsId, true);
    return files.map((f) => ({
      path: f.path,
      name: baseName(f.path),
      isDir: f.isDir,
    }));
  };

  return {
    id: `workspace:${wsId}`,
    label,
    caps: CLOUD_CAPS,
    listTree,
    listDir: (dir) => oneLevel(listTree, dir),
    // Feeds the @ index (文件中枢统一 F4) — flat, files-only, server-pruned/capped.
    listFileIndex: () => wsListFileIndex(wsId),
    read: (path) => wsReadFile(wsId, path).then(adaptPreview),
    createFile: (path) => wsUploadFile(wsId, path, new Blob([])),
    mkdir: (path) => wsCreateDir(wsId, path),
    move: (src, dst) => wsMoveFile(wsId, src, dst),
    delete: (path) => wsDeleteFile(wsId, path),
    writeBytes: (path, body) => wsUploadFile(wsId, path, body),
    download: (path, filename) => wsDownloadFile(wsId, path, filename),
  };
}

/** Derive a single directory level from a source's recursive `listTree`
 * (cloud workspaces have no per-dir endpoint). Shared by both cloud sources. */
async function oneLevel(
  listTree: () => Promise<FileNode[]>,
  dir: string,
): Promise<FileNode[]> {
  const all = await listTree();
  const prefix = dir ? `${dir}/` : "";
  return all.filter((n) => {
    if (!n.path.startsWith(prefix)) return false;
    const rest = n.path.slice(prefix.length);
    return rest.length > 0 && !rest.includes("/");
  });
}
