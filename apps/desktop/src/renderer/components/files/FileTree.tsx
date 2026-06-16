import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  type FileNode,
  type FileSource,
  baseName,
  joinPath,
  parentDir,
} from "@/lib/fileSource";
import { notifyError } from "@/lib/toast";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Download,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Centered, EmptyHint, IconButton, InlineError } from "./parts";
import { useFileTreeData } from "./useFileTreeData";

// Internal drag payload (a source-relative path + its source id). A custom MIME
// distinguishes it from an OS file drag (which carries `Files` → "upload"); the
// source id scopes the move so a node can't be dropped onto a different source.
const DRAG_MIME = "application/x-agentcore-file";

interface DragPayload {
  sourceId: string;
  path: string;
}

const expandedKey = (id: string): string => `agentcore:filetree-expanded:${id}`;

function loadExpanded(id: string): Set<string> {
  try {
    const raw = localStorage.getItem(expandedKey(id));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

function saveExpanded(id: string, set: Set<string>): void {
  try {
    localStorage.setItem(expandedKey(id), JSON.stringify([...set]));
  } catch {
    /* unavailable — session-only */
  }
}

/**
 * The unified file tree for any {@link FileSource} (文件中枢统一 Step 0) — the one
 * tree that backs both the Files page (a local OS root) and the conversation
 * workspace panel (the server workspace). Capabilities gate the chrome: upload
 * appears only when the source can transfer bytes; live updates only when it can
 * watch. Interaction model is converged on inline create/rename + a right-click
 * context menu + drag-to-move (within the source), with per-source persisted
 * fold state. The container owns where a clicked file opens (via `onOpenFile`).
 */
export function FileTree({
  source,
  onOpenFile,
  activePath = null,
  headerExtra,
}: {
  source: FileSource;
  onOpenFile: (path: string, name: string) => void;
  activePath?: string | null;
  headerExtra?: React.ReactNode;
}) {
  const data = useFileTreeData(source);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    loadExpanded(source.id),
  );
  const [creating, setCreating] = useState<{
    dir: string;
    kind: "file" | "dir";
  } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setExpanded(loadExpanded(source.id));
  }, [source.id]);

  // Live updates: watch the root + every expanded dir (local FS only).
  useEffect(() => {
    const watch = source.watch;
    if (!watch || !source.caps.watch) return;
    const offs = ["", ...expanded].map((dir) =>
      watch(dir, () => data.reload(dir)),
    );
    return () => {
      for (const off of offs) off();
    };
  }, [source, expanded, data]);

  const toggle = useCallback(
    (dir: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) next.delete(dir);
        else {
          next.add(dir);
          data.ensureDir(dir);
        }
        saveExpanded(source.id, next);
        return next;
      });
    },
    [data, source.id],
  );

  const collapseAll = useCallback(() => {
    saveExpanded(source.id, new Set());
    setExpanded(new Set());
  }, [source.id]);

  const refresh = useCallback(() => {
    data.reload("");
    for (const dir of expanded) data.reload(dir);
  }, [data, expanded]);

  const openCreate = useCallback(
    (dir: string, kind: "file" | "dir") => {
      if (dir !== "") {
        setExpanded((prev) => {
          if (prev.has(dir)) return prev;
          const next = new Set(prev).add(dir);
          data.ensureDir(dir);
          saveExpanded(source.id, next);
          return next;
        });
      }
      setCreating({ dir, kind });
    },
    [data, source.id],
  );

  const submitCreate = useCallback(
    async (rawName: string) => {
      const target = creating;
      setCreating(null);
      if (!target) return;
      const name = rawName.trim().replace(/^\/+|\/+$/g, "");
      if (!name || name.includes("/")) return;
      const path = joinPath(target.dir, name);
      try {
        if (target.kind === "dir") await source.mkdir(path);
        else await source.createFile(path);
        data.reload(target.dir);
        if (target.kind === "file") onOpenFile(path, name);
      } catch {
        notifyError("已存在同名文件或文件夹，或创建失败");
      }
    },
    [creating, source, data, onOpenFile],
  );

  const submitRename = useCallback(
    async (path: string, rawName: string) => {
      setRenaming(null);
      const name = rawName.trim();
      if (!name || name === baseName(path)) return;
      if (name.includes("/")) {
        notifyError("名称不能包含「/」");
        return;
      }
      const dst = joinPath(parentDir(path), name);
      try {
        await source.move(path, dst);
        data.reload(parentDir(path));
      } catch {
        notifyError("已存在同名文件，或重命名失败");
      }
    },
    [source, data],
  );

  const remove = useCallback(
    async (node: FileNode) => {
      const what = node.isDir ? "文件夹及其全部内容" : "文件";
      if (
        !window.confirm(`确定删除${what}「${node.name}」？此操作不可撤销。`)
      ) {
        return;
      }
      try {
        await source.delete(node.path);
        data.reload(parentDir(node.path));
      } catch {
        notifyError("删除失败");
      }
    },
    [source, data],
  );

  // Move `src` into `destDir` (""=root), keeping its name. Guards against a no-op
  // and against dropping a folder into its own subtree.
  const moveInto = useCallback(
    async (src: string, destDir: string) => {
      const dst = joinPath(destDir, baseName(src));
      if (dst === src) return;
      if (destDir === src || destDir.startsWith(`${src}/`)) return;
      try {
        await source.move(src, dst);
        data.reload(parentDir(src));
        data.reload(destDir);
      } catch {
        notifyError("目标位置已存在同名文件，或移动失败");
      }
    },
    [source, data],
  );

  const upload = useCallback(
    async (files: FileList | null, destDir = "") => {
      if (!files || files.length === 0 || !source.writeBytes) return;
      setUploading(true);
      try {
        for (const file of Array.from(files)) {
          await source.writeBytes(joinPath(destDir, file.name), file);
        }
        data.reload(destDir);
      } catch {
        notifyError("上传失败");
      } finally {
        setUploading(false);
      }
    },
    [source, data],
  );

  const rootStatus = data.statusOf("");
  const rootChildren = data.childrenOf("");

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME)) setDropTarget(null);
        else if (source.caps.transfer) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        setDropTarget(null);
        const raw = e.dataTransfer.getData(DRAG_MIME);
        if (raw) {
          e.preventDefault();
          const p = parsePayload(raw);
          if (p && p.sourceId === source.id) void moveInto(p.path, "");
          return;
        }
        if (source.caps.transfer && e.dataTransfer.files.length > 0) {
          e.preventDefault();
          void upload(e.dataTransfer.files, "");
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-1 px-3 py-2">
        {source.caps.transfer && (
          <>
            <button
              type="button"
              onClick={() => uploadRef.current?.click()}
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
              ref={uploadRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void upload(e.target.files, "");
                e.target.value = "";
              }}
            />
          </>
        )}
        <IconButton title="新建文件" onClick={() => openCreate("", "file")}>
          <FilePlus size={14} />
        </IconButton>
        <IconButton title="新建文件夹" onClick={() => openCreate("", "dir")}>
          <FolderPlus size={14} />
        </IconButton>
        <div className="flex-1" />
        {expanded.size > 0 && (
          <IconButton title="全部折叠" onClick={collapseAll}>
            <ChevronsDownUp size={14} />
          </IconButton>
        )}
        <IconButton
          title="刷新"
          onClick={refresh}
          spinning={rootStatus === "loading"}
        >
          <RefreshCw size={14} />
        </IconButton>
        {headerExtra}
      </div>

      {dragOver && source.caps.transfer && (
        <div className="mx-3 mb-2 shrink-0 rounded-lg border border-dashed border-primary bg-primary/5 px-3 py-4 text-center text-xs text-primary">
          松开以上传到此处
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {rootStatus === "error" ? (
          <InlineError onRetry={() => data.reload("")} />
        ) : rootChildren === undefined ? (
          <Centered>
            <Loader2
              size={18}
              className="animate-spin text-muted-foreground/50"
            />
          </Centered>
        ) : rootChildren.length === 0 && !creating ? (
          <EmptyHint
            inline
            icon={<FileText size={22} className="text-muted-foreground/40" />}
            title="暂无文件"
            hint={
              source.caps.transfer
                ? "拖拽文件到此处，或点「上传」「新建」开始。"
                : "点「新建」开始，或在此文件夹放入文件。"
            }
          />
        ) : (
          <ul>
            {creating?.dir === "" && (
              <InlineCreateRow
                kind={creating.kind}
                depth={0}
                onSubmit={submitCreate}
                onCancel={() => setCreating(null)}
              />
            )}
            {(rootChildren ?? []).map((node) => (
              <Row
                key={node.path}
                node={node}
                depth={0}
                source={source}
                data={data}
                expanded={expanded}
                activePath={activePath}
                creating={creating}
                renaming={renaming}
                dropTarget={dropTarget}
                onToggle={toggle}
                onOpenFile={onOpenFile}
                onContextCreate={openCreate}
                onStartRename={setRenaming}
                onSubmitRename={submitRename}
                onCancelRename={() => setRenaming(null)}
                onSubmitCreate={submitCreate}
                onCancelCreate={() => setCreating(null)}
                onDelete={remove}
                onMoveInto={moveInto}
                onUpload={upload}
                onDropTarget={setDropTarget}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function parsePayload(raw: string): DragPayload | null {
  try {
    const p: unknown = JSON.parse(raw);
    if (
      p &&
      typeof p === "object" &&
      typeof (p as DragPayload).sourceId === "string" &&
      typeof (p as DragPayload).path === "string"
    ) {
      return p as DragPayload;
    }
  } catch {
    /* not our payload */
  }
  return null;
}

interface RowProps {
  node: FileNode;
  depth: number;
  source: FileSource;
  data: ReturnType<typeof useFileTreeData>;
  expanded: Set<string>;
  activePath: string | null;
  creating: { dir: string; kind: "file" | "dir" } | null;
  renaming: string | null;
  dropTarget: string | null;
  onToggle: (dir: string) => void;
  onOpenFile: (path: string, name: string) => void;
  onContextCreate: (dir: string, kind: "file" | "dir") => void;
  onStartRename: (path: string) => void;
  onSubmitRename: (path: string, name: string) => void;
  onCancelRename: () => void;
  onSubmitCreate: (name: string) => void;
  onCancelCreate: () => void;
  onDelete: (node: FileNode) => void;
  onMoveInto: (src: string, destDir: string) => void;
  onUpload: (files: FileList | null, destDir: string) => void;
  onDropTarget: (path: string | null) => void;
}

function Row(props: RowProps) {
  const { node, depth, source, data, expanded, dropTarget } = props;
  const indent = depth * 14 + 8;

  const startDrag = (e: React.DragEvent) => {
    const payload: DragPayload = { sourceId: source.id, path: node.path };
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
  };

  if (!node.isDir) {
    const isActive = props.activePath === node.path;
    return (
      <li>
        {props.renaming === node.path ? (
          <InlineRow indent={indent} icon={<FileText size={13} />}>
            <InlineInput
              initial={node.name}
              onSubmit={(v) => props.onSubmitRename(node.path, v)}
              onCancel={props.onCancelRename}
            />
          </InlineRow>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                draggable
                onDragStart={startDrag}
                className={`group flex items-center rounded-md pr-1 text-xs hover:bg-accent ${
                  isActive ? "bg-accent text-accent-foreground" : ""
                }`}
                style={{ paddingLeft: indent }}
              >
                <SimpleTooltip label={`预览 ${node.path}`}>
                  <button
                    type="button"
                    onClick={() => props.onOpenFile(node.path, node.name)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
                  >
                    <span className="w-[13px] shrink-0" aria-hidden="true" />
                    <FileText
                      size={13}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  </button>
                </SimpleTooltip>
              </div>
            </ContextMenuTrigger>
            <RowMenu {...props} />
          </ContextMenu>
        )}
      </li>
    );
  }

  // Directory row.
  const open = expanded.has(node.path);
  const isTarget = dropTarget === node.path;
  const status = data.statusOf(node.path);
  const children = data.childrenOf(node.path);

  return (
    <li>
      {props.renaming === node.path ? (
        <InlineRow indent={indent} icon={<Folder size={13} />}>
          <InlineInput
            initial={node.name}
            onSubmit={(v) => props.onSubmitRename(node.path, v)}
            onCancel={props.onCancelRename}
          />
        </InlineRow>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              draggable
              onDragStart={startDrag}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(DRAG_MIME)) {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onDropTarget(node.path);
                } else if (source.caps.transfer) {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onDropTarget(node.path);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onDropTarget(null);
                const raw = e.dataTransfer.getData(DRAG_MIME);
                if (raw) {
                  const p = parsePayload(raw);
                  if (p && p.sourceId === source.id)
                    props.onMoveInto(p.path, node.path);
                  return;
                }
                if (source.caps.transfer && e.dataTransfer.files.length > 0)
                  props.onUpload(e.dataTransfer.files, node.path);
              }}
              className={`group flex items-center rounded-md pr-1 text-xs hover:bg-accent ${
                isTarget ? "bg-accent ring-1 ring-inset ring-primary" : ""
              }`}
              style={{ paddingLeft: indent }}
            >
              <SimpleTooltip label={node.path}>
                <button
                  type="button"
                  onClick={() => props.onToggle(node.path)}
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
                    <Folder
                      size={13}
                      className="shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                </button>
              </SimpleTooltip>
            </div>
          </ContextMenuTrigger>
          <RowMenu {...props} />
        </ContextMenu>
      )}

      {open && (
        <ul>
          {props.creating?.dir === node.path && (
            <InlineCreateRow
              kind={props.creating.kind}
              depth={depth + 1}
              onSubmit={props.onSubmitCreate}
              onCancel={props.onCancelCreate}
            />
          )}
          {status === "loading" && children === undefined && (
            <li
              className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: (depth + 1) * 14 + 8 + 18 }}
            >
              <Loader2 size={12} className="animate-spin" />
              加载中…
            </li>
          )}
          {status === "error" && (
            <li
              className="py-1 text-xs text-destructive/80"
              style={{ paddingLeft: (depth + 1) * 14 + 8 + 18 }}
            >
              加载失败
            </li>
          )}
          {children?.length === 0 && !props.creating && (
            <li
              className="py-1 text-xs text-muted-foreground/60"
              style={{ paddingLeft: (depth + 1) * 14 + 8 + 18 }}
            >
              空文件夹
            </li>
          )}
          {children?.map((child) => (
            <Row key={child.path} {...props} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The shared right-click menu for a file/folder row. */
function RowMenu({
  node,
  source,
  onContextCreate,
  onStartRename,
  onDelete,
  onOpenFile,
}: { node: FileNode; source: FileSource } & Pick<
  RowProps,
  "onContextCreate" | "onStartRename" | "onDelete" | "onOpenFile"
>) {
  return (
    <ContextMenuContent className="min-w-36">
      {node.isDir && (
        <>
          <ContextMenuItem onSelect={() => onContextCreate(node.path, "file")}>
            <FilePlus size={14} className="shrink-0" />
            <span className="flex-1 truncate">新建文件</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onContextCreate(node.path, "dir")}>
            <FolderPlus size={14} className="shrink-0" />
            <span className="flex-1 truncate">新建文件夹</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {!node.isDir && source.caps.transfer && source.download && (
        <ContextMenuItem
          onSelect={() => void source.download?.(node.path, node.name)}
        >
          <Download size={14} className="shrink-0" />
          <span className="flex-1 truncate">下载</span>
        </ContextMenuItem>
      )}
      {!node.isDir && (
        <ContextMenuItem onSelect={() => onOpenFile(node.path, node.name)}>
          <FileText size={14} className="shrink-0" />
          <span className="flex-1 truncate">打开</span>
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => onStartRename(node.path)}>
        <Pencil size={14} className="shrink-0" />
        <span className="flex-1 truncate">重命名</span>
      </ContextMenuItem>
      <ContextMenuItem variant="danger" onSelect={() => void onDelete(node)}>
        <Trash2 size={14} className="shrink-0" />
        <span className="flex-1 truncate">删除</span>
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

function InlineRow({
  indent,
  icon,
  children,
}: {
  indent: number;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-md pr-1 text-xs"
      style={{ paddingLeft: indent }}
    >
      <span className="w-[13px] shrink-0" aria-hidden="true" />
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      {children}
    </div>
  );
}

function InlineCreateRow({
  kind,
  depth,
  onSubmit,
  onCancel,
}: {
  kind: "file" | "dir";
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  return (
    <li>
      <InlineRow
        indent={depth * 14 + 8}
        icon={kind === "dir" ? <Folder size={13} /> : <FileText size={13} />}
      >
        <InlineInput initial="" onSubmit={onSubmit} onCancel={onCancel} />
      </InlineRow>
    </li>
  );
}

function InlineInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit(value);
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={onCancel}
      className="my-0.5 h-5 min-w-0 flex-1 rounded border border-primary/50 bg-background px-1 text-xs outline-none"
    />
  );
}
