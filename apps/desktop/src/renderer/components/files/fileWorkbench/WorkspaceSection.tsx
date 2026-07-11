import { FileTree, type FileTreeHandle } from "@/components/files/FileTree";
import { IconButton } from "@/components/files/parts";
import { Button } from "@/components/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  useDeleteConversation,
  useRenameConversation,
} from "@/hooks/useConversations";
import { removeConversationScratch } from "@/hooks/useWorkspaces";
import type { FileSource } from "@/lib/fileSource";
import { queryClient } from "@/lib/queryClient";
import { workspaceKeys } from "@/lib/queryKeys";
import { notifyActionError, notifyError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { WorkspaceInfo } from "@/services/workspaces";
import { useConversationStore } from "@/stores/conversation";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Eraser,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  HardDrive,
  MessageSquare,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { conversationIdOf } from "./storage";

/**
 * One conversation scratch workspace = a **flat, collapsible section**: a header
 * (chevron + conversation title + cloud/local badge + create buttons) with its file
 * tree shown beneath **only when expanded**. Lifecycle is decoupled from sidebar
 * folders — the context menu opens the owning conversation, clears files, deletes
 * or renames the conversation; file CRUD stays on the tree.
 */
export function WorkspaceSection({
  ws,
  source,
  activePath,
  expanded,
  onToggle,
  onOpenFile,
  flashing,
}: {
  ws: WorkspaceInfo;
  source: FileSource | null;
  activePath: string | null;
  expanded: boolean;
  onToggle: () => void;
  onOpenFile: (path: string, name: string) => void;
  flashing: boolean;
}) {
  const conversationId = conversationIdOf(ws.wsId);
  const isLocal = ws.location === "local";
  const localUnavailable = isLocal && !source;
  const navigate = useNavigate();

  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<FileTreeHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);
  const [pendingAction, setPendingAction] = useState<
    "file" | "dir" | "upload" | null
  >(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ws.name);

  const deleteMutation = useDeleteConversation();
  const renameMutation = useRenameConversation();
  const currentId = useConversationStore((s) => s.currentConversationId);
  const dropConversationRuntime = useConversationStore(
    (s) => s.dropConversationRuntime,
  );

  const deleteConfirmLabel = isLocal
    ? "确认永久删除（本地磁盘文件会保留）"
    : "确认永久删除（无法恢复）";

  useEffect(() => {
    if (flashing) rootRef.current?.scrollIntoView({ block: "nearest" });
  }, [flashing]);

  useEffect(() => {
    if (!expanded || !pendingAction) return;
    if (pendingAction === "upload") treeRef.current?.triggerUpload();
    else treeRef.current?.startCreate(pendingAction);
    setPendingAction(null);
  }, [expanded, pendingAction]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(ws.name);
  }, [ws.name, editing]);

  const requestTreeAction = (action: "file" | "dir" | "upload") => {
    if (expanded) {
      if (action === "upload") treeRef.current?.triggerUpload();
      else treeRef.current?.startCreate(action);
    } else {
      setPendingAction(action);
      onToggle();
    }
  };

  const revealRoot = async () => {
    try {
      await source?.revealInOsFileManager?.("");
    } catch (e) {
      notifyActionError("无法在资源管理器中显示", e);
    }
  };

  const openConversation = () => {
    if (!conversationId) return;
    navigate(`/conversations/${conversationId}`);
  };

  const startEdit = () => {
    if (!conversationId) return;
    setConfirmingDelete(false);
    setDraft(ws.name);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    if (!conversationId) return;
    const title = draft.trim();
    if (!title || title === ws.name) return;
    renameMutation.mutate(
      { id: conversationId, title },
      { onError: (err) => notifyError(err, "重命名失败") },
    );
  };

  const requestDeleteConversation = () => {
    if (!conversationId) return;
    setEditing(false);
    setConfirmingDelete(true);
  };

  const handleDeleteConversation = async () => {
    if (!conversationId) return;
    setConfirmingDelete(false);
    const wasActive = conversationId === currentId;
    try {
      await deleteMutation.mutateAsync(conversationId);
    } catch (err) {
      notifyError(err, "删除失败");
      return;
    }
    dropConversationRuntime(conversationId);
    if (wasActive) navigate("/");
  };

  /** Enumerate top-level entries and delete each — root itself is not deletable. */
  const clearWorkspaceFiles = async () => {
    if (!source) return;
    if (
      !window.confirm(
        `确定清空工作区「${ws.name}」下的全部文件？此操作不可撤销。`,
      )
    ) {
      return;
    }
    try {
      const items = await source.listDir("");
      for (const item of items) {
        await source.delete(item.path);
      }
      // Cloud scratch with no files drops off GET /v1/workspaces; local binding
      // may keep the section — refresh the rail either way.
      if (conversationId && !isLocal) {
        removeConversationScratch(conversationId);
      }
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
      treeRef.current?.refresh();
    } catch (e) {
      notifyActionError("清空失败", e);
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
    }
  };

  const header = editing ? (
    <div
      className={cn(
        "flex h-9 items-center rounded-lg px-2",
        flashing && "ring-2 ring-inset ring-primary",
      )}
    >
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            inputRef.current?.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            skipBlurRef.current = true;
            setEditing(false);
          }
        }}
        onBlur={() => {
          if (skipBlurRef.current) {
            skipBlurRef.current = false;
            return;
          }
          commitEdit();
        }}
        className="h-7 min-w-0 flex-1 bg-transparent px-1 text-sm focus:outline-none"
        aria-label="重命名工作区"
      />
    </div>
  ) : (
    <div
      className={cn(
        "group flex items-center rounded-lg pr-1 text-sm",
        flashing && "ring-2 ring-inset ring-primary",
      )}
    >
      <Button
        variant="ghost"
        onClick={onToggle}
        aria-expanded={expanded}
        className="h-auto min-h-9 min-w-0 flex-1 justify-start gap-1.5 overflow-hidden rounded-none py-1.5 pl-2 pr-0 text-left text-sm font-medium"
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        )}
        {expanded ? (
          <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <Folder size={14} className="shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{ws.name}</span>
      </Button>
      {confirmingDelete ? (
        <div className="flex shrink-0 items-center">
          <IconButton
            title={deleteConfirmLabel}
            onClick={() => void handleDeleteConversation()}
          >
            <Check size={14} className="text-destructive" />
          </IconButton>
          <IconButton title="取消" onClick={() => setConfirmingDelete(false)}>
            <X size={14} />
          </IconButton>
        </div>
      ) : (
        source && (
          <div className="hidden shrink-0 items-center group-hover:flex">
            <IconButton
              title="新建文件"
              onClick={() => requestTreeAction("file")}
            >
              <FilePlus size={14} />
            </IconButton>
            <IconButton
              title="新建文件夹"
              onClick={() => requestTreeAction("dir")}
            >
              <FolderPlus size={14} />
            </IconButton>
          </div>
        )
      )}
      <span
        className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs ${
          isLocal
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {isLocal ? <HardDrive size={12} /> : <Cloud size={12} />}
        {isLocal ? "本地" : "云端"}
      </span>
    </div>
  );

  const tree = localUnavailable ? (
    <div className="py-1 pl-7 text-xs text-muted-foreground/70">
      本地项目的文件在你电脑上，请在桌面端查看。
    </div>
  ) : source ? (
    <FileTree
      ref={treeRef}
      source={source}
      chrome={false}
      indent={14}
      activePath={activePath}
      onOpenFile={onOpenFile}
      emptyText="还没有文件——对话里 AI 产出的文件会落在这里"
    />
  ) : (
    <div className="py-1 pl-7 text-xs text-muted-foreground/70">
      无法打开此工作区，文件源暂不可用。
    </div>
  );

  return (
    <div ref={rootRef}>
      {editing ? (
        header
      ) : (
        <ContextMenu
          onOpenChange={(open) => {
            if (open) setConfirmingDelete(false);
          }}
        >
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent className="min-w-44">
            {!localUnavailable && source && (
              <>
                <ContextMenuItem onSelect={() => requestTreeAction("file")}>
                  <FilePlus size={14} className="shrink-0" />
                  <span className="flex-1 truncate">新建文件</span>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => requestTreeAction("dir")}>
                  <FolderPlus size={14} className="shrink-0" />
                  <span className="flex-1 truncate">新建文件夹</span>
                </ContextMenuItem>
                {source.caps.transfer && (
                  <ContextMenuItem onSelect={() => requestTreeAction("upload")}>
                    <Upload size={14} className="shrink-0" />
                    <span className="flex-1 truncate">上传文件</span>
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
              </>
            )}
            {source?.revealInOsFileManager && (
              <>
                <ContextMenuItem onSelect={() => void revealRoot()}>
                  <FolderSearch size={14} className="shrink-0" />
                  <span className="flex-1 truncate">在资源管理器中显示</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            {conversationId && (
              <ContextMenuItem onSelect={openConversation}>
                <MessageSquare size={14} className="shrink-0" />
                <span className="flex-1 truncate">打开对话</span>
              </ContextMenuItem>
            )}
            {!localUnavailable && source && (
              <ContextMenuItem
                variant="danger"
                onSelect={() => void clearWorkspaceFiles()}
              >
                <Eraser size={14} className="shrink-0" />
                <span className="flex-1 truncate">清空工作区文件</span>
              </ContextMenuItem>
            )}
            {conversationId && (
              <>
                <ContextMenuItem onSelect={startEdit}>
                  <Pencil size={14} className="shrink-0" />
                  <span className="flex-1 truncate">重命名</span>
                </ContextMenuItem>
                <ContextMenuItem
                  variant="danger"
                  onSelect={requestDeleteConversation}
                >
                  <Trash2 size={14} className="shrink-0" />
                  <span className="flex-1 truncate">删除对话</span>
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      )}
      {expanded && tree}
    </div>
  );
}
