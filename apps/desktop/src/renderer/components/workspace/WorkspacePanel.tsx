import { SimpleTooltip } from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/format";
import { notifyError } from "@/lib/toast";
import { ApiError } from "@/services/api";
import {
  type FilePreview,
  type WorkspaceFile,
  type WorkspaceSnapshot,
  createSnapshot,
  createWorkspaceDir,
  deleteWorkspaceFile,
  downloadSnapshot,
  downloadWorkspaceFile,
  listSnapshots,
  listWorkspaceFiles,
  moveWorkspaceFile,
  readWorkspaceFile,
  restoreSnapshot,
  uploadWorkspaceFile,
} from "@/services/workspace";
import { useConversationStore } from "@/stores/conversation";
import { useSidePanelStore } from "@/stores/sidePanel";
import {
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  FilePlus,
  FileText,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  GitPullRequest,
  History,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HandoffSection } from "./HandoffSection";
import { WorkspaceModeBar } from "./WorkspaceModeBar";

// Tree fold state is per-conversation (paths differ per workspace) and persisted
// so a switch away and back keeps the same folders open/closed.
const COLLAPSED_KEY_PREFIX = "agentcore:workspace-collapsed:";

function loadCollapsed(conversationId: string): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY_PREFIX + conversationId);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

function saveCollapsed(conversationId: string, paths: Set<string>): void {
  try {
    localStorage.setItem(
      COLLAPSED_KEY_PREFIX + conversationId,
      JSON.stringify([...paths]),
    );
  } catch {
    /* unavailable — session-only */
  }
}

// Internal drag-to-move payload (a workspace-relative path). A custom MIME keeps
// it distinct from an OS file drag (which carries `Files` and means "upload").
const DRAG_MIME = "application/x-workspace-path";

function startPathDrag(e: React.DragEvent, path: string): void {
  e.dataTransfer.setData(DRAG_MIME, path);
  e.dataTransfer.effectAllowed = "move";
}

/**
 * Workspace mode of the conversation side panel — the file-in/out + persistence
 * surface for a conversation's project space (双模式工作区). It strings the
 * already-landed cloud-mode backend together: browse/download/upload the live
 * workspace files (文件进出) and manage snapshots (axis-3 — backup / kept
 * versions / restore / zip download). The shell (SidePanel) owns the frame /
 * resize / close; this renders the mode bar + sections.
 *
 * A draft conversation (no id yet) has no server workspace, so it shows an empty
 * hint until the first turn persists it.
 */
export function WorkspaceMode() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const section = useSidePanelStore((s) => s.section);
  const setSection = useSidePanelStore((s) => s.setSection);

  if (!conversationId) {
    return (
      <EmptyHint
        inline
        icon={<FolderOpen size={26} className="text-muted-foreground/40" />}
        title="尚无工作区"
        hint="发送第一条消息后，这个对话的项目空间就会出现在这里。"
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <WorkspaceModeBar conversationId={conversationId} />
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <SectionTab
          active={section === "files"}
          onClick={() => setSection("files")}
          icon={<Files size={13} />}
          label="文件"
        />
        <SectionTab
          active={section === "snapshots"}
          onClick={() => setSection("snapshots")}
          icon={<History size={13} />}
          label="快照"
        />
        <SectionTab
          active={section === "handoff"}
          onClick={() => setSection("handoff")}
          icon={<GitPullRequest size={13} />}
          label="交接"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {section === "files" ? (
          <FilesSection conversationId={conversationId} />
        ) : section === "snapshots" ? (
          <SnapshotsSection conversationId={conversationId} />
        ) : (
          <HandoffSection conversationId={conversationId} />
        )}
      </div>
    </div>
  );
}

function SectionTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// --- Files ---

function FilesSection({ conversationId }: { conversationId: string }) {
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    loadCollapsed(conversationId),
  );
  const [preview, setPreview] = useState<{ path: string; name: string } | null>(
    null,
  );
  // The folder currently hovered as a drag-to-move target (highlighted), or null.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-hydrate the fold state when the conversation switches under an open panel.
  useEffect(() => {
    setCollapsed(loadCollapsed(conversationId));
  }, [conversationId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setFiles(await listWorkspaceFiles(conversationId));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleUpload = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setUploading(true);
      try {
        for (const file of Array.from(fileList)) {
          await uploadWorkspaceFile(conversationId, file.name, file);
        }
        await reload();
      } catch {
        setError(true);
      } finally {
        setUploading(false);
      }
    },
    [conversationId, reload],
  );

  // Move a node into a folder (destDir "" = workspace root). No-ops when it's
  // already there or would drop a folder into its own subtree.
  const moveInto = useCallback(
    async (srcPath: string, destDir: string) => {
      const name = srcPath.slice(srcPath.lastIndexOf("/") + 1);
      const dst = destDir ? `${destDir}/${name}` : name;
      if (dst === srcPath) return;
      if (destDir === srcPath || destDir.startsWith(`${srcPath}/`)) return;
      try {
        await moveWorkspaceFile(conversationId, srcPath, dst);
        await reload();
      } catch (err) {
        notifyError(
          err instanceof ApiError && err.status === 422
            ? "目标位置已存在同名文件"
            : "移动失败",
        );
      }
    },
    [conversationId, reload],
  );

  const onNewFolder = useCallback(async () => {
    const input = window.prompt("新建文件夹名称：", "");
    if (input == null) return;
    const name = input.trim().replace(/^\/+|\/+$/g, "");
    if (!name) return;
    try {
      await createWorkspaceDir(conversationId, name);
      await reload();
    } catch (err) {
      notifyError(
        err instanceof ApiError && err.status === 422
          ? "已存在同名文件或文件夹"
          : "新建文件夹失败",
      );
    }
  }, [conversationId, reload]);

  // Create an empty file then open it in the editor. Upload PUT overwrites, so a
  // name-collision is guarded against the current listing (no clobber-on-create).
  const onNewFile = useCallback(async () => {
    const input = window.prompt("新建文件名称：", "");
    if (input == null) return;
    const name = input.trim().replace(/^\/+|\/+$/g, "");
    if (!name) return;
    if (files?.some((f) => f.path === name)) {
      notifyError("已存在同名文件或文件夹");
      return;
    }
    try {
      await uploadWorkspaceFile(conversationId, name, new Blob([]));
      await reload();
      setPreview({ path: name, name: name.slice(name.lastIndexOf("/") + 1) });
    } catch {
      notifyError("新建文件失败");
    }
  }, [conversationId, files, reload]);

  const tree = useMemo(() => (files ? buildTree(files) : []), [files]);
  const allDirs = useMemo(() => collectDirPaths(tree), [tree]);

  const apply = useCallback(
    (next: Set<string>) => {
      saveCollapsed(conversationId, next);
      setCollapsed(next);
    },
    [conversationId],
  );
  const toggle = useCallback(
    (path: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        saveCollapsed(conversationId, next);
        return next;
      });
    },
    [conversationId],
  );
  const expandAll = useCallback(() => apply(new Set()), [apply]);
  const collapseAll = useCallback(
    () => apply(new Set(allDirs)),
    [apply, allDirs],
  );

  if (preview) {
    return (
      <FilePreviewView
        conversationId={conversationId}
        path={preview.path}
        name={preview.name}
        onClose={() => setPreview(null)}
      />
    );
  }

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        // Internal move over empty area → root is the implicit target (clear any
        // folder highlight); an OS file drag → show the upload affordance.
        if (e.dataTransfer.types.includes(DRAG_MIME)) setDropTarget(null);
        else setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDragEnd={() => {
        setDragOver(false);
        setDropTarget(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        setDropTarget(null);
        const src = e.dataTransfer.getData(DRAG_MIME);
        if (src) {
          void moveInto(src, ""); // dropped on empty area → move to root
          return;
        }
        void handleUpload(e.dataTransfer.files);
      }}
    >
      <div className="flex shrink-0 items-center gap-1 px-3 py-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {uploading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Upload size={13} />
          )}
          上传
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleUpload(e.target.files);
            e.target.value = "";
          }}
        />
        <IconButton title="新建文件" onClick={() => void onNewFile()}>
          <FilePlus size={14} />
        </IconButton>
        <IconButton title="新建文件夹" onClick={() => void onNewFolder()}>
          <FolderPlus size={14} />
        </IconButton>
        <div className="flex-1" />
        {allDirs.length > 0 && (
          <>
            <IconButton title="全部展开" onClick={expandAll}>
              <ChevronsUpDown size={14} />
            </IconButton>
            <IconButton title="全部折叠" onClick={collapseAll}>
              <ChevronsDownUp size={14} />
            </IconButton>
          </>
        )}
        <IconButton
          title="刷新"
          onClick={() => void reload()}
          spinning={loading}
        >
          <RefreshCw size={14} />
        </IconButton>
      </div>

      {dragOver && (
        <div className="mx-3 mb-2 shrink-0 rounded-lg border border-dashed border-primary bg-primary/5 px-3 py-4 text-center text-xs text-primary">
          松开以上传到工作区
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error ? (
          <InlineError onRetry={() => void reload()} />
        ) : files === null ? (
          <Centered>
            <Loader2
              size={18}
              className="animate-spin text-muted-foreground/50"
            />
          </Centered>
        ) : tree.length === 0 ? (
          <EmptyHint
            inline
            icon={<Files size={22} className="text-muted-foreground/40" />}
            title="工作区暂无文件"
            hint="拖拽文件到此处，或点「上传」把文件放进项目空间。"
          />
        ) : (
          <ul>
            {tree.map((node) => (
              <TreeRow
                key={node.path}
                node={node}
                depth={0}
                collapsed={collapsed}
                onToggle={toggle}
                conversationId={conversationId}
                onPreview={(p, n) => setPreview({ path: p, name: n })}
                onChanged={() => void reload()}
                dropTarget={dropTarget}
                onDropTarget={setDropTarget}
                onMoveInto={(src, dest) => void moveInto(src, dest)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface TreeNode {
  name: string;
  /** Full workspace-relative POSIX path. */
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

/**
 * Fold the recursive flat listing into a nested tree. Ancestor folders are
 * synthesized from each file's path (so the tree is complete even if the API
 * omits empty-dir entries), then deduped against any explicit dir entries.
 * Each level is sorted dirs-first, then by name.
 */
function buildTree(entries: WorkspaceFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  const ensureDir = (path: string): TreeNode => {
    const found = byPath.get(path);
    if (found) return found;
    const slash = path.lastIndexOf("/");
    const node: TreeNode = {
      name: slash >= 0 ? path.slice(slash + 1) : path,
      path,
      isDir: true,
      children: [],
    };
    byPath.set(path, node);
    if (slash >= 0) ensureDir(path.slice(0, slash)).children.push(node);
    else root.push(node);
    return node;
  };

  for (const e of entries) {
    if (e.isDir) {
      ensureDir(e.path);
      continue;
    }
    if (byPath.has(e.path)) continue;
    const slash = e.path.lastIndexOf("/");
    const node: TreeNode = {
      name: slash >= 0 ? e.path.slice(slash + 1) : e.path,
      path: e.path,
      isDir: false,
      children: [],
    };
    byPath.set(e.path, node);
    if (slash >= 0) ensureDir(e.path.slice(0, slash)).children.push(node);
    else root.push(node);
  }

  const sort = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
    );
    for (const n of nodes) if (n.children.length) sort(n.children);
  };
  sort(root);
  return root;
}

/** Every directory path in the tree (for the collapse-all action). */
function collectDirPaths(nodes: TreeNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.isDir) {
      acc.push(n.path);
      collectDirPaths(n.children, acc);
    }
  }
  return acc;
}

function TreeRow({
  node,
  depth,
  collapsed,
  onToggle,
  conversationId,
  onPreview,
  onChanged,
  dropTarget,
  onDropTarget,
  onMoveInto,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  conversationId: string;
  onPreview: (path: string, name: string) => void;
  onChanged: () => void;
  dropTarget: string | null;
  onDropTarget: (path: string | null) => void;
  onMoveInto: (src: string, destDir: string) => void;
}) {
  const indent = depth * 14 + 8;

  if (!node.isDir) {
    return (
      <FileLeaf
        node={node}
        indent={indent}
        conversationId={conversationId}
        onPreview={onPreview}
        onChanged={onChanged}
      />
    );
  }

  const open = !collapsed.has(node.path);
  const isTarget = dropTarget === node.path;
  return (
    <li>
      {/* Folder rows are both a drag source (move the folder) and a drop target
          (drop a file/folder in to move it here). */}
      <div
        style={{ paddingLeft: indent }}
        draggable
        onDragStart={(e) => startPathDrag(e, node.path)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
          e.preventDefault();
          e.stopPropagation();
          onDropTarget(node.path);
        }}
        onDrop={(e) => {
          const src = e.dataTransfer.getData(DRAG_MIME);
          if (!src) return;
          e.preventDefault();
          e.stopPropagation();
          onDropTarget(null);
          onMoveInto(src, node.path);
        }}
        className={`group flex items-center rounded-md pr-1 text-xs hover:bg-accent ${
          isTarget ? "bg-accent ring-1 ring-inset ring-primary" : ""
        }`}
      >
        <SimpleTooltip label={node.path}>
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
          >
            {open ? (
              <ChevronDown
                size={13}
                className="shrink-0 text-muted-foreground"
              />
            ) : (
              <ChevronRight
                size={13}
                className="shrink-0 text-muted-foreground"
              />
            )}
            {open ? (
              <FolderOpen
                size={13}
                className="shrink-0 text-muted-foreground"
              />
            ) : (
              <Folder size={13} className="shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
          </button>
        </SimpleTooltip>
        <RowActions
          conversationId={conversationId}
          node={node}
          onChanged={onChanged}
        />
      </div>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              conversationId={conversationId}
              onPreview={onPreview}
              onChanged={onChanged}
              dropTarget={dropTarget}
              onDropTarget={onDropTarget}
              onMoveInto={onMoveInto}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * A file row: clicking the name opens an in-panel read-only preview; the
 * hover-revealed icons download / rename / delete. Sibling buttons (not nested)
 * keep the actions distinct.
 */
function FileLeaf({
  node,
  indent,
  conversationId,
  onPreview,
  onChanged,
}: {
  node: TreeNode;
  indent: number;
  conversationId: string;
  onPreview: (path: string, name: string) => void;
  onChanged: () => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  const onDownload = async () => {
    if (state === "loading") return;
    setState("loading");
    try {
      await downloadWorkspaceFile(conversationId, node.path, node.name);
      setState("idle");
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2000);
    }
  };

  return (
    <li>
      <div
        style={{ paddingLeft: indent }}
        draggable
        onDragStart={(e) => startPathDrag(e, node.path)}
        className="group flex items-center rounded-md pr-1 text-xs hover:bg-accent"
      >
        <SimpleTooltip label={`预览 ${node.path}`}>
          <button
            type="button"
            onClick={() => onPreview(node.path, node.name)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
          >
            {/* spacer aligns the file icon under the folder icon (past the chevron) */}
            <span className="w-[13px] shrink-0" aria-hidden="true" />
            <FileText size={13} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
          </button>
        </SimpleTooltip>
        <SimpleTooltip
          label={state === "error" ? "下载失败，点击重试" : `下载 ${node.name}`}
        >
          <button
            type="button"
            onClick={onDownload}
            className={`flex size-6 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted group-hover:opacity-100 ${
              state === "error" ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {state === "loading" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
          </button>
        </SimpleTooltip>
        <RowActions
          conversationId={conversationId}
          node={node}
          onChanged={onChanged}
        />
      </div>
    </li>
  );
}

/**
 * Hover-revealed rename + delete actions shared by file and folder rows.
 * Rename keeps the entry in its parent dir (a bare new name, no slashes); delete
 * is irreversible (folders go recursively) so it confirms first.
 */
function RowActions({
  conversationId,
  node,
  onChanged,
}: {
  conversationId: string;
  node: TreeNode;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"rename" | "delete" | null>(null);

  const onRename = async () => {
    if (busy) return;
    const input = window.prompt(`重命名「${node.name}」为：`, node.name);
    if (input == null) return;
    const next = input.trim();
    if (!next || next === node.name) return;
    if (next.includes("/")) {
      notifyError("名称不能包含「/」");
      return;
    }
    const slash = node.path.lastIndexOf("/");
    const dst = slash >= 0 ? `${node.path.slice(0, slash + 1)}${next}` : next;
    setBusy("rename");
    try {
      await moveWorkspaceFile(conversationId, node.path, dst);
      onChanged();
    } catch (err) {
      notifyError(
        err instanceof ApiError && err.status === 422
          ? "已存在同名文件"
          : "重命名失败",
      );
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    if (busy) return;
    const what = node.isDir ? "文件夹及其全部内容" : "文件";
    if (!window.confirm(`确定删除${what}「${node.name}」？此操作不可撤销。`)) {
      return;
    }
    setBusy("delete");
    try {
      await deleteWorkspaceFile(conversationId, node.path);
      onChanged();
    } catch {
      notifyError("删除失败");
    } finally {
      setBusy(null);
    }
  };

  const visible = busy ? "opacity-100" : "opacity-0 group-hover:opacity-100";
  return (
    <>
      <SimpleTooltip label="重命名">
        <button
          type="button"
          onClick={onRename}
          disabled={busy !== null}
          className={`flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted ${visible}`}
        >
          {busy === "rename" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Pencil size={12} />
          )}
        </button>
      </SimpleTooltip>
      <SimpleTooltip label="删除">
        <button
          type="button"
          onClick={onDelete}
          disabled={busy !== null}
          className={`flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive ${visible}`}
        >
          {busy === "delete" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Trash2 size={12} />
          )}
        </button>
      </SimpleTooltip>
    </>
  );
}

/**
 * In-panel preview of one workspace file, with opt-in editing for whole text
 * files. Takes over the files section (with a back arrow); a header download
 * button still pulls the raw file. Binary / oversized files fall back to a
 * download-only notice. Saving writes the buffer back through the upload PUT.
 */
function FilePreviewView({
  conversationId,
  path,
  name,
  onClose,
}: {
  conversationId: string;
  path: string;
  name: string;
  onClose: () => void;
}) {
  const [result, setResult] = useState<FilePreview | null>(null);
  const [error, setError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setResult(null);
    setError(false);
    setEditing(false);
    try {
      setResult(await readWorkspaceFile(conversationId, path));
    } catch {
      setError(true);
    }
  }, [conversationId, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const onDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadWorkspaceFile(conversationId, path, name);
    } catch {
      /* transient; the header button just re-enables */
    } finally {
      setDownloading(false);
    }
  };

  // Editing is offered only for a whole text file: a truncated preview would
  // drop its tail on save, so oversized/binary stay read-only (download).
  const canEdit = result?.kind === "text" && !result.truncated;
  const dirty = editing && result?.kind === "text" && draft !== result.text;

  const startEdit = () => {
    if (result?.kind === "text" && !result.truncated) {
      setDraft(result.text);
      setEditing(true);
    }
  };

  const onSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await uploadWorkspaceFile(conversationId, path, new Blob([draft]));
      setResult({ kind: "text", text: draft, truncated: false });
      setEditing(false);
    } catch {
      notifyError("保存失败");
    } finally {
      setSaving(false);
    }
  }, [saving, conversationId, path, draft]);

  // Confirm before discarding unsaved edits (back to list, or cancel editing).
  const requestClose = () => {
    if (dirty && !window.confirm("有未保存的改动，确定放弃并返回？")) return;
    onClose();
  };
  const cancelEdit = () => {
    if (dirty && !window.confirm("有未保存的改动，确定放弃编辑？")) return;
    setEditing(false);
  };

  // Ctrl/Cmd+S saves while editing (and swallows the browser's save dialog).
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void onSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, onSave]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border pl-1 pr-1">
        <SimpleTooltip label="返回文件列表">
          <button
            type="button"
            onClick={requestClose}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft size={16} />
          </button>
        </SimpleTooltip>
        <FileText size={13} className="shrink-0 text-muted-foreground" />
        <SimpleTooltip label={path}>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {dirty && <span className="text-primary">● </span>}
            {name}
          </span>
        </SimpleTooltip>
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={saving}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {saving ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Save size={13} />
              )}
              保存
            </button>
            <IconButton title="取消编辑" onClick={cancelEdit}>
              <X size={14} />
            </IconButton>
          </>
        ) : (
          <>
            {canEdit && (
              <IconButton title="编辑" onClick={startEdit}>
                <Pencil size={14} />
              </IconButton>
            )}
            <IconButton
              title="下载文件"
              onClick={() => void onDownload()}
              spinning={downloading}
            >
              <Download size={14} />
            </IconButton>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="block h-full w-full resize-none border-0 bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground outline-none"
          />
        ) : error ? (
          <InlineError onRetry={() => void load()} />
        ) : result === null ? (
          <Centered>
            <Loader2
              size={18}
              className="animate-spin text-muted-foreground/50"
            />
          </Centered>
        ) : result.kind === "text" ? (
          <>
            {result.truncated && (
              <div className="border-b border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
                文件较大，仅预览前 512 KB，完整内容请下载。
              </div>
            )}
            <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
              {result.text}
            </pre>
          </>
        ) : (
          <EmptyHint
            inline
            icon={<FileText size={22} className="text-muted-foreground/40" />}
            title={result.kind === "binary" ? "无法预览此文件" : "文件过大"}
            hint={
              result.kind === "binary"
                ? "这是二进制文件，点上方下载按钮取回。"
                : "超过 5 MB 不在面板内预览，请下载查看。"
            }
          />
        )}
      </div>
    </div>
  );
}

// --- Snapshots ---

function SnapshotsSection({ conversationId }: { conversationId: string }) {
  const [snaps, setSnaps] = useState<WorkspaceSnapshot[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setSnaps(await listSnapshots(conversationId));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await createSnapshot(conversationId, label);
      setLabel("");
      await reload();
    } catch {
      setError(true);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onCreate();
          }}
          placeholder="版本名（可选）"
          maxLength={200}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
        />
        <SimpleTooltip label="为当前工作区留一个快照版本">
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={creating}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {creating ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Camera size={13} />
            )}
            留版本
          </button>
        </SimpleTooltip>
        <IconButton
          title="刷新"
          onClick={() => void reload()}
          spinning={loading}
        >
          <RefreshCw size={14} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error ? (
          <InlineError onRetry={() => void reload()} />
        ) : snaps === null ? (
          <Centered>
            <Loader2
              size={18}
              className="animate-spin text-muted-foreground/50"
            />
          </Centered>
        ) : snaps.length === 0 ? (
          <EmptyHint
            inline
            icon={<History size={22} className="text-muted-foreground/40" />}
            title="暂无快照"
            hint="改动文件的回合结束后会自动备份；也可随时手动留一个版本。"
          />
        ) : (
          <ul className="space-y-1">
            {snaps.map((s) => (
              <SnapshotRow
                key={s.snapshotId}
                conversationId={conversationId}
                snap={s}
                onRestored={() => void reload()}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SnapshotRow({
  conversationId,
  snap,
  onRestored,
}: {
  conversationId: string;
  snap: WorkspaceSnapshot;
  onRestored: () => void;
}) {
  const [busy, setBusy] = useState<"download" | "restore" | null>(null);

  const onDownload = async () => {
    if (busy) return;
    setBusy("download");
    try {
      await downloadSnapshot(conversationId, snap.snapshotId);
    } catch {
      /* surfaced by the button's transient state only */
    } finally {
      setBusy(null);
    }
  };

  const onRestore = async () => {
    if (busy) return;
    if (!window.confirm("恢复到该快照会覆盖当前工作区的所有文件，确定继续？")) {
      return;
    }
    setBusy("restore");
    try {
      await restoreSnapshot(conversationId, snap.snapshotId);
      onRestored();
    } catch {
      /* best-effort; the list reload reflects the real state */
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="rounded-md border border-border px-2.5 py-2">
      <div className="flex items-center gap-2">
        {snap.label ? (
          <SimpleTooltip label={snap.label}>
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {snap.label}
            </span>
          </SimpleTooltip>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            自动备份
          </span>
        )}
        <IconButton
          title="下载快照 (zip)"
          onClick={() => void onDownload()}
          spinning={busy === "download"}
        >
          <Download size={13} />
        </IconButton>
        <IconButton
          title="恢复到此快照"
          onClick={() => void onRestore()}
          spinning={busy === "restore"}
        >
          <RotateCcw size={13} />
        </IconButton>
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{formatWhen(snap.createdAt)}</span>
        <span>·</span>
        <span>{formatBytes(snap.sizeBytes)}</span>
      </div>
    </li>
  );
}

// --- Shared bits ---

function IconButton({
  title,
  onClick,
  spinning,
  children,
}: {
  title: string;
  onClick: () => void;
  spinning?: boolean;
  children: React.ReactNode;
}) {
  return (
    <SimpleTooltip label={title}>
      <button
        type="button"
        onClick={onClick}
        disabled={spinning}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
      >
        {spinning ? <Loader2 size={14} className="animate-spin" /> : children}
      </button>
    </SimpleTooltip>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">{children}</div>
  );
}

function InlineError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-xs text-muted-foreground">加载失败</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
      >
        重试
      </button>
    </div>
  );
}

function EmptyHint({
  icon,
  title,
  hint,
  inline,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  inline?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 px-6 text-center ${
        inline ? "h-full" : "flex-1"
      }`}
    >
      {icon}
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** Compact local timestamp for a snapshot row (e.g. "06-15 03:04"). */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
