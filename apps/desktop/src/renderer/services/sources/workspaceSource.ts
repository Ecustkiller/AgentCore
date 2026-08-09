import { getConversations } from "@/hooks/useConversations";
import { hasInAppPreview } from "@/lib/capabilities";
import {
  type FileNode,
  type FilePreviewResult,
  type FileSource,
  baseName,
} from "@/lib/fileSource";
import { openWorkspaceHtmlInBrowser } from "@/lib/openWorkspaceHtmlInBrowser";
import { resolveConversationLocalTarget } from "@/services/sidecarRouting";
import {
  createWorkspaceDir,
  deleteWorkspaceFile,
  downloadWorkspaceFile,
  exportWorkspaceMdToDocx,
  listWorkspaceFiles,
  moveWorkspaceFile,
  openWorkspaceInBrowser,
  readWorkspaceFile,
  readWorkspaceFileForEdit,
  uploadWorkspaceFile,
  writeWorkspaceFileText,
} from "@/services/workspace";
import type {
  WorkspaceEditDoc,
  WorkspaceFile,
  FilePreview as WorkspacePreview,
  WorkspaceWriteOutcome,
} from "@/services/workspaceHttp";
import type { WorkspaceInfo } from "@/services/workspaces";
import {
  openCloudWorkspaceInBrowser,
  wsCreateDir,
  wsDeleteFile,
  wsDownloadFile,
  wsExportMdToDocx,
  wsListFileIndex,
  wsListFiles,
  wsMoveFile,
  wsReadFile,
  wsReadFileForEdit,
  wsUploadFile,
  wsWriteFileText,
} from "@/services/workspaces";
import { createLocalRootSource } from "./localRootSource";

/** Map the cloud preview wire shape into the unified {@link FilePreviewResult}. */
function adaptPreview(p: WorkspacePreview): FilePreviewResult {
  if (p.kind === "text") {
    return { kind: "text", text: p.text, truncated: p.truncated };
  }
  if (p.kind === "image") {
    return {
      kind: "image",
      dataUrl: p.dataUrl,
      mime: p.mime,
      size: p.size,
    };
  }
  if (p.kind === "too-large") return { kind: "too-large" };
  return {
    kind: "binary",
    mime: p.mime,
    size: p.size,
    reason: p.reason,
  };
}

/**
 * Hang HTML full-effect exits on a cloud {@link FileSource}.
 *
 * - `openInAppPreview` 跟落地 desk：传当前源的 `folder:` / `conv:` wsId（缺省
 *   `conv:{conversationId}`）；hub `folder:` 在有能力位时同样挂上。
 * - `openInBrowser` via conversation snapshot, or ws-id snapshot for hub
 *   `folder:` / `conv:` (shared spaces refuse snapshots in v1).
 */
function withCloudHtmlEntries(
  source: FileSource,
  opts: { conversationId?: string; wsId?: string },
): FileSource {
  const withExtras: FileSource = { ...source };
  const conversationId = opts.conversationId;
  const wsId = opts.wsId;

  if (conversationId) {
    if (window.fsApi?.previewArchive) {
      withExtras.openInBrowser = (path) =>
        openWorkspaceInBrowser(conversationId, path);
    }
  } else if (
    wsId &&
    !wsId.startsWith("shared:") &&
    window.fsApi?.previewArchive
  ) {
    withExtras.openInBrowser = (path) =>
      openCloudWorkspaceInBrowser(wsId, path);
  }

  // 完整预览跟桌：落地 wsId = 显式 desk，否则会话 `conv:{cid}`；shared 无 desk 预览。
  const landingWsId =
    wsId ?? (conversationId ? `conv:${conversationId}` : undefined);
  if (hasInAppPreview() && landingWsId && !landingWsId.startsWith("shared:")) {
    // hub `folder:` 无会话时用 folder id 作页/分区作用域；desk 仍走 workspaceId。
    const cid =
      conversationId ??
      (landingWsId.startsWith("conv:")
        ? landingWsId.slice("conv:".length)
        : landingWsId.startsWith("folder:")
          ? landingWsId.slice("folder:".length)
          : undefined);
    if (cid) {
      withExtras.openInAppPreview = (path) =>
        openWorkspaceHtmlInBrowser(cid, path, landingWsId);
    }
  }
  return withExtras;
}

/** The cloud workspace caps — shared by the conversation- and ws-id-keyed sources. */
const CLOUD_CAPS = {
  watch: false,
  transfer: true,
  edit: true,
  snapshots: true,
} as const;

/** Viewer / readonly shared-space: browse + download, no mutate / in-panel edit. */
const CLOUD_READONLY_CAPS = {
  watch: false,
  transfer: true,
  edit: false,
  snapshots: false,
} as const;

/**
 * The addressing-agnostic REST surface a cloud {@link FileSource} needs. The two
 * cloud sources differ only in *how they address* their workspace (conversation id
 * vs workspace id), so each binds its own client and shares the source body in
 * {@link makeCloudSource} — the file hub and chat panel can't drift on cloud
 * behaviour. `listFileIndex` is optional: only the ws-id client exposes the @ index.
 */
interface CloudFileClient {
  listFiles(recursive: boolean): Promise<WorkspaceFile[]>;
  read(path: string): Promise<WorkspacePreview>;
  readForEdit(path: string): Promise<WorkspaceEditDoc>;
  writeText(
    path: string,
    input: { content: string; eol: "lf" | "crlf"; baselineMtimeMs: number },
  ): Promise<WorkspaceWriteOutcome>;
  upload(path: string, body: Blob): Promise<void>;
  createDir(path: string): Promise<void>;
  move(src: string, dst: string): Promise<void>;
  delete(path: string): Promise<void>;
  download(path: string, filename: string): Promise<void>;
  exportMdToDocx(path: string): Promise<{ path: string; warnings: string[] }>;
  listFileIndex?(): Promise<string[]>;
}

/** Path-aware `AgentCore/{index,trash,baselines}` — mirrors main `isInternalZoneRelPath`. */
function isInternalZonePath(path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!p || p === ".") return false;
  for (const zone of ["index", "trash", "baselines"] as const) {
    const prefix = `AgentCore/${zone}`;
    if (p === prefix || p.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function toFileNodes(files: WorkspaceFile[]): FileNode[] {
  return files
    .filter((f) => !isInternalZonePath(f.path))
    .map((f) => ({
      path: f.path,
      name: baseName(f.path),
      isDir: f.isDir,
    }));
}

/** Direct children of `dir` from a flat listing (root when `dir` is ""). */
function oneLevelFrom(all: FileNode[], dir: string): FileNode[] {
  const prefix = dir ? `${dir}/` : "";
  return all.filter((n) => {
    if (isInternalZonePath(n.path)) return false;
    if (!n.path.startsWith(prefix)) return false;
    const rest = n.path.slice(prefix.length);
    return rest.length > 0 && !rest.includes("/");
  });
}

/**
 * Build a cloud {@link FileSource} over a {@link CloudFileClient}. Shared by both
 * cloud factories so the hub (ws id) and chat panel (conversation id) stay
 * byte-for-byte identical on everything but addressing.
 *
 * Listing strategy (fc35aece): do **not** eager-`listTree` via recursive REST.
 * Server recursive list is hard-capped (~100, alphabetical); a large `site/` tree
 * can push root-level AI zips/media out of the budget so the file panel looks
 * empty while「改动」still sees the paths. Root uses non-recursive list; subdirs
 * best-effort filter a recursive call (same cap). Omit `listTree` so {@link
 * FileTree} stays lazy and always hits the root non-recursive path first.
 */
function makeCloudSource(
  key: string,
  label: string,
  client: CloudFileClient,
  caps: typeof CLOUD_CAPS | typeof CLOUD_READONLY_CAPS = CLOUD_CAPS,
): FileSource {
  const listDir = async (dir: string): Promise<FileNode[]> => {
    if (!dir) {
      return toFileNodes(await client.listFiles(false));
    }
    return oneLevelFrom(toFileNodes(await client.listFiles(true)), dir);
  };

  const fileIndex = client.listFileIndex;
  return {
    id: `workspace:${key}`,
    label,
    caps,
    listDir,
    // Feeds the @ index (文件中枢统一 F4) — flat, files-only, server-pruned/capped.
    ...(fileIndex ? { listFileIndex: fileIndex } : {}),
    read: (path) => client.read(path).then(adaptPreview),
    readForEdit: async (path) => {
      const d = await client.readForEdit(path);
      return {
        text: d.text,
        version: { mtimeMs: d.mtimeMs },
        encoding: "utf-8",
        eol: d.eol,
      };
    },
    writeText: async (path, input) => {
      const r = await client.writeText(path, {
        content: input.content,
        eol: input.eol,
        baselineMtimeMs: input.baseline?.mtimeMs ?? 0,
      });
      return r.ok
        ? { ok: true, version: { mtimeMs: r.mtimeMs } }
        : { ok: false, reason: "conflict", version: { mtimeMs: r.mtimeMs } };
    },
    createFile: (path) => client.upload(path, new Blob([])),
    mkdir: (path) => client.createDir(path),
    move: (src, dst) => client.move(src, dst),
    delete: (path) => client.delete(path),
    writeBytes: (path, body) => client.upload(path, body),
    download: (path, filename) => client.download(path, filename),
    ...(caps.edit
      ? {
          exportMdToDocx: (path: string) => client.exportMdToDocx(path),
        }
      : {}),
  };
}

/**
 * A {@link FileSource} over a conversation's server workspace (cloud mode, REST),
 * keyed by conversationId — the chat panel's source (per-conversation alias). The
 * hub addresses the same spaces by workspace id via {@link createCloudWorkspaceSource}.
 */
export function createWorkspaceSource(
  conversationId: string,
  label = "工作区",
): FileSource {
  const source = makeCloudSource(conversationId, label, {
    listFiles: (recursive) => listWorkspaceFiles(conversationId, recursive),
    read: (path) => readWorkspaceFile(conversationId, path),
    readForEdit: (path) => readWorkspaceFileForEdit(conversationId, path),
    writeText: (path, input) =>
      writeWorkspaceFileText(conversationId, path, input),
    upload: (path, body) => uploadWorkspaceFile(conversationId, path, body),
    createDir: (path) => createWorkspaceDir(conversationId, path),
    move: (src, dst) => moveWorkspaceFile(conversationId, src, dst),
    delete: (path) => deleteWorkspaceFile(conversationId, path),
    download: (path, filename) =>
      downloadWorkspaceFile(conversationId, path, filename),
    exportMdToDocx: (path) => exportWorkspaceMdToDocx(conversationId, path),
  });
  // 桌面专属 HTML 完整效果出口（web stub 不提供 → 面板源码 + 下载兜底）。
  return withCloudHtmlEntries(source, {
    conversationId,
    wsId: `conv:${conversationId}`,
  });
}

/**
 * A {@link FileSource} over a **cloud** workspace addressed by its workspace id
 * (`/v1/workspaces/{wsId}`, 文件中枢统一 Step 2) — the hub's source for cloud
 * projects. Identical shape to {@link createWorkspaceSource}; only the addressing
 * (ws id vs conversation id) differs, plus the @ index this exposes. Local
 * workspaces never use this — the hub picks `LocalRootSource` (IPC) for them (§五).
 */
export function createCloudWorkspaceSource(
  wsId: string,
  label = "工作区",
  opts?: { readonly?: boolean },
): FileSource {
  const readonly = !!opts?.readonly;
  const source = makeCloudSource(
    wsId,
    label,
    {
      listFiles: (recursive) => wsListFiles(wsId, recursive),
      read: (path) => wsReadFile(wsId, path),
      readForEdit: (path) => wsReadFileForEdit(wsId, path),
      writeText: (path, input) => wsWriteFileText(wsId, path, input),
      upload: (path, body) => wsUploadFile(wsId, path, body),
      createDir: (path) => wsCreateDir(wsId, path),
      move: (src, dst) => wsMoveFile(wsId, src, dst),
      delete: (path) => wsDeleteFile(wsId, path),
      download: (path, filename) => wsDownloadFile(wsId, path, filename),
      exportMdToDocx: (path) => wsExportMdToDocx(wsId, path),
      listFileIndex: () => wsListFileIndex(wsId),
    },
    readonly ? CLOUD_READONLY_CAPS : CLOUD_CAPS,
  );
  // Hub cloud sources: `conv:` / `folder:` → 完整预览跟桌；`shared:` → 无快照/预览。
  if (wsId.startsWith("conv:")) {
    return withCloudHtmlEntries(source, {
      conversationId: wsId.slice("conv:".length),
      wsId,
    });
  }
  return withCloudHtmlEntries(source, { wsId });
}

/**
 * Resolve a {@link WorkspaceInfo} to its {@link FileSource} — the single home for
 * "which file backend for this workspace": cloud → REST by ws id
 * ({@link createCloudWorkspaceSource}), local → desktop IPC over the bound root
 * ({@link createLocalRootSource}). Shared by the 文件 hub ({@link FileWorkbench}) and
 * the conversation side panel so the two can never drift on cloud/local selection
 * (the drift that let an agent's local file write go unseen by the cloud-only panel).
 *
 * Local resolves only on desktop (needs `window.fsApi` + a bound root); a non-empty
 * `ws.subpath` (工作区对称化 D1a) scopes the local source to that subtree under the
 * shared container root. Returns null when a local workspace can't be served here
 * (no fsApi / no root) so callers render the "在桌面端查看" degradation instead.
 */
export function resolveWorkspaceSource(
  ws: WorkspaceInfo,
  fsAvailable: boolean,
): FileSource | null {
  if (ws.location === "local") {
    if (!fsAvailable || !ws.rootId) return null;
    return createLocalRootSource(ws.rootId, ws.name, ws.subpath);
  }
  return createCloudWorkspaceSource(ws.wsId, ws.name);
}

/**
 * When the workspace list has no `conv:<id>` row yet, fall back to the same
 * local target resolution sidecar uses (`localContainerRootId` + workspace-cache
 * subpath). Returns null when no on-machine local binding exists — callers then
 * use the conversation-keyed cloud REST source.
 */
export async function resolveConversationLocalFileSource(
  conversationId: string,
): Promise<FileSource | null> {
  const target = await resolveConversationLocalTarget(conversationId);
  if (!target) return null;

  const roots = await window.fsApi.listRoots();
  const root = roots.find((r) => r.id === target.rootId);
  if (!root) return null;

  const conv = getConversations().find((c) => c.id === conversationId);
  const label = conv?.title || root.name || "工作区";
  return createLocalRootSource(target.rootId, label, target.subpath);
}
