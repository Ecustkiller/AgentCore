import { useFilesStore } from "@/stores/files";
import type { FsCreateKind, FsEntry, FsResult } from "@shared/ipc-contract";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const DND_MIME = "application/x-agentcore-fs";

interface DragPayload {
  rootId: string;
  relPath: string;
}

interface FileTreeNodeProps {
  rootId: string;
  name: string;
  /** 相对根路径；根目录为 ""。 */
  relPath: string;
  kind: "file" | "dir";
  depth: number;
  isRoot?: boolean;
  /** 仅根节点提供：从授权列表移除该根。 */
  onRemoveRoot?: () => void;
}

interface MenuPos {
  x: number;
  y: number;
}

export function FileTreeNode({
  rootId,
  name,
  relPath,
  kind,
  depth,
  isRoot = false,
  onRemoveRoot,
}: FileTreeNodeProps) {
  const isDir = kind === "dir";
  const selected = useFilesStore((s) => s.selected);
  const select = useFilesStore((s) => s.select);

  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState<FsCreateKind | null>(null);
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const isSelected =
    !isDir && selected?.rootId === rootId && selected?.relPath === relPath;

  const refresh = useCallback(async () => {
    if (!isDir) return;
    setLoading(true);
    const res = await window.fsApi.listDir(rootId, relPath);
    setLoading(false);
    if (res.ok) {
      setChildren(res.data);
      setListError(null);
    } else {
      setChildren(null);
      setListError(res.reason);
    }
  }, [isDir, rootId, relPath]);

  // 展开即懒读 + watch；折叠即停止 watch。变更命中则重读本层。
  useEffect(() => {
    if (!isDir || !expanded) return;
    refresh();
    window.fsApi.watch(rootId, relPath);
    const off = window.fsApi.onChanged((e) => {
      if (e.rootId === rootId && e.relPath === relPath) refresh();
    });
    return () => {
      window.fsApi.unwatch(rootId, relPath);
      off();
    };
  }, [isDir, expanded, rootId, relPath, refresh]);

  const flashError = useCallback((reason: string) => {
    setOpError(reason);
    setTimeout(() => setOpError(null), 3000);
  }, []);

  const runOp = useCallback(
    async (p: Promise<FsResult>) => {
      const res = await p;
      if (!res.ok) flashError(res.reason);
      return res.ok;
    },
    [flashError],
  );

  const handleRowClick = () => {
    if (isDir) {
      setExpanded((v) => !v);
    } else {
      select({ rootId, relPath, name });
    }
  };

  const startCreate = (kind: FsCreateKind) => {
    setMenu(null);
    setExpanded(true);
    setCreating(kind);
  };

  const submitCreate = async (value: string) => {
    const trimmed = value.trim();
    setCreating(null);
    if (!trimmed) return;
    const childRel = relPath ? `${relPath}/${trimmed}` : trimmed;
    await runOp(window.fsApi.create(rootId, childRel, creating ?? "file"));
  };

  const submitRename = async (value: string) => {
    const trimmed = value.trim();
    setRenaming(false);
    if (!trimmed || trimmed === name) return;
    const ok = await runOp(window.fsApi.rename(rootId, relPath, trimmed));
    if (ok && isSelected) select(null);
  };

  const handleDelete = async () => {
    setMenu(null);
    if (!window.confirm(`删除 “${name}”？此操作不可撤销。`)) return;
    const ok = await runOp(window.fsApi.delete(rootId, relPath));
    if (ok && isSelected) select(null);
  };

  // ---- 拖拽移动 ----
  const handleDragStart = (e: React.DragEvent) => {
    if (isRoot) {
      e.preventDefault();
      return;
    }
    const payload: DragPayload = { rootId, relPath };
    e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!isDir) return;
    if (!e.dataTransfer.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!dragOver) setDragOver(true);
  };

  const handleDrop = async (e: React.DragEvent) => {
    if (!isDir) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    let payload: DragPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (payload.rootId !== rootId) {
      flashError("暂不支持跨文件夹根移动");
      return;
    }
    if (payload.relPath === relPath) return;
    setExpanded(true);
    await runOp(window.fsApi.move(rootId, payload.relPath, relPath));
  };

  const indent = depth * 14 + 8;

  return (
    <div>
      {/** biome-ignore lint/a11y/useKeyWithClickEvents: 树节点以原生 button 子元素承载键盘语义，行容器仅为视觉/拖拽载体 */}
      <div
        className={`group flex h-7 cursor-pointer items-center gap-1 rounded-md pr-2 text-sm transition-colors ${
          isSelected
            ? "bg-accent text-accent-foreground"
            : "text-foreground hover:bg-accent/60"
        } ${dragOver ? "ring-1 ring-inset ring-primary/60" : ""}`}
        style={{ paddingLeft: indent }}
        draggable={!isRoot && !renaming}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onClick={renaming ? undefined : handleRowClick}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {isDir ? (
            expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : null}
        </span>
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {isDir ? (
            expanded ? (
              <FolderOpen size={14} />
            ) : (
              <FolderClosed size={14} />
            )
          ) : (
            <FileIcon size={14} />
          )}
        </span>

        {renaming ? (
          <InlineInput
            initial={name}
            onSubmit={submitRename}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="flex-1 truncate">{name}</span>
        )}

        {isRoot && !renaming && (
          <button
            type="button"
            title="移除该文件夹"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveRoot?.();
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/0 transition-colors hover:bg-background hover:text-foreground group-hover:text-muted-foreground"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {opError && (
        <div
          className="py-0.5 text-xs text-destructive"
          style={{ paddingLeft: indent + 20 }}
        >
          {opError}
        </div>
      )}

      {isDir && expanded && (
        <div>
          {creating && (
            <InlineCreateRow
              kind={creating}
              indent={indent + 14}
              onSubmit={submitCreate}
              onCancel={() => setCreating(null)}
            />
          )}

          {loading && !children && (
            <div
              className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: indent + 20 }}
            >
              <Loader2 size={12} className="animate-spin" />
              加载中…
            </div>
          )}

          {listError && (
            <div
              className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: indent + 20 }}
            >
              <span className="text-destructive/80">未连接</span>
              <button
                type="button"
                onClick={() => refresh()}
                className="rounded px-1.5 py-0.5 text-xs text-primary hover:bg-accent"
              >
                重试
              </button>
            </div>
          )}

          {children?.length === 0 && !creating && (
            <div
              className="py-1 text-xs text-muted-foreground/60"
              style={{ paddingLeft: indent + 20 }}
            >
              空文件夹
            </div>
          )}

          {children?.map((c) => (
            <FileTreeNode
              key={c.relPath}
              rootId={rootId}
              name={c.name}
              relPath={c.relPath}
              kind={c.kind}
              depth={depth + 1}
            />
          ))}
        </div>
      )}

      {menu && (
        <ContextMenu
          pos={menu}
          isDir={isDir}
          isRoot={isRoot}
          onClose={() => setMenu(null)}
          onNewFile={() => startCreate("file")}
          onNewDir={() => startCreate("dir")}
          onRename={() => {
            setMenu(null);
            setRenaming(true);
          }}
          onDelete={handleDelete}
          onRemoveRoot={
            isRoot && onRemoveRoot
              ? () => {
                  setMenu(null);
                  onRemoveRoot();
                }
              : undefined
          }
        />
      )}
    </div>
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
      onBlur={() => onCancel()}
      className="h-5 flex-1 rounded border border-primary/50 bg-background px-1 text-sm outline-none"
    />
  );
}

function InlineCreateRow({
  kind,
  indent,
  onSubmit,
  onCancel,
}: {
  kind: FsCreateKind;
  indent: number;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="flex h-7 items-center gap-1 pr-2"
      style={{ paddingLeft: indent }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {kind === "dir" ? <FolderClosed size={14} /> : <FileIcon size={14} />}
      </span>
      <InlineInput initial="" onSubmit={onSubmit} onCancel={onCancel} />
    </div>
  );
}

interface ContextMenuProps {
  pos: MenuPos;
  isDir: boolean;
  isRoot: boolean;
  onClose: () => void;
  onNewFile: () => void;
  onNewDir: () => void;
  onRename: () => void;
  onDelete: () => void;
  onRemoveRoot?: () => void;
}

function ContextMenu({
  pos,
  isDir,
  isRoot,
  onClose,
  onNewFile,
  onNewDir,
  onRename,
  onDelete,
  onRemoveRoot,
}: ContextMenuProps) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 菜单容器仅阻止冒泡，可操作项均为 button
    <div
      className="fixed z-50 min-w-36 overflow-hidden rounded-lg border border-border bg-popover py-1 text-sm shadow-lg"
      style={{ top: pos.y, left: pos.x }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {isDir && (
        <>
          <MenuItem
            icon={<FilePlus size={14} />}
            label="新建文件"
            onClick={onNewFile}
          />
          <MenuItem
            icon={<FolderPlus size={14} />}
            label="新建文件夹"
            onClick={onNewDir}
          />
          {(!isRoot || onRemoveRoot) && <Divider />}
        </>
      )}
      {!isRoot && (
        <MenuItem
          icon={<Pencil size={14} />}
          label="重命名"
          onClick={onRename}
        />
      )}
      {!isRoot && (
        <MenuItem
          icon={<Trash2 size={14} />}
          label="删除"
          onClick={onDelete}
          danger
        />
      )}
      {isRoot && onRemoveRoot && (
        <MenuItem
          icon={<X size={14} />}
          label="移除该文件夹"
          onClick={onRemoveRoot}
        />
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent ${
        danger ? "text-destructive" : "text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-border" />;
}
