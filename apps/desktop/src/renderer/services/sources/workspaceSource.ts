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

/** Map the server preview shape into the unified result (server has no image kind). */
function adaptPreview(p: WorkspacePreview): FilePreviewResult {
  if (p.kind === "text") {
    return { kind: "text", text: p.text, truncated: p.truncated };
  }
  if (p.kind === "too-large") return { kind: "too-large" };
  return { kind: "binary" };
}

/**
 * A {@link FileSource} over a conversation's server workspace (cloud mode, REST).
 *
 * Keyed by conversationId today; 文件中枢统一 Step 1 will re-key these endpoints to
 * a workspace id (`/v1/workspaces/{wsId}`), at which point only the URLs in
 * `services/workspace` change. The server lists recursively in one call, so
 * `listTree` is the natural primitive and `listDir` filters it to a single level.
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
    caps: {
      watch: false,
      transfer: true,
      edit: true,
      snapshots: true,
      handoff: true,
    },
    listTree,
    async listDir(dir) {
      // No per-dir endpoint server-side; derive a level from the recursive list.
      const all = await listTree();
      const prefix = dir ? `${dir}/` : "";
      return all.filter((n) => {
        if (!n.path.startsWith(prefix)) return false;
        const rest = n.path.slice(prefix.length);
        return rest.length > 0 && !rest.includes("/");
      });
    },
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
