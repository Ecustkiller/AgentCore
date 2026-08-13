import { ClearScratchDialog } from "@/components/files/ClearScratchDialog";
import { CloneRepoDialog } from "@/components/files/CloneRepoDialog";
import { FileTree, type FileTreeHandle } from "@/components/files/FileTree";
import { IconButton } from "@/components/files/parts";
import { DeleteFolderDialog } from "@/components/folders/DeleteFolderDialog";
import { Button } from "@/components/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  getConversations,
  useDeleteConversation,
  useRenameConversation,
} from "@/hooks/useConversations";
import {
  getFolders,
  releaseFolderConversations,
  useDeleteFolder,
  usePermanentDeleteFolder,
  useRestoreFolder,
  useUpdateFolder,
} from "@/hooks/useFolders";
import { removeConversationScratch } from "@/hooks/useWorkspaces";
import { deriveGroupWorkspaceIsLocal } from "@/lib/conversationWorkspaceMode";
import type { FileSource } from "@/lib/fileSource";
import { queryClient } from "@/lib/queryClient";
import { workspaceKeys } from "@/lib/queryKeys";
import { notifyActionError, notifyError, notifyInfo } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { WorkspaceInfo } from "@/services/workspaces";
import {
  useConversationGenerating,
  useConversationStore,
} from "@/stores/conversation";
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
  GitBranch,
  HardDrive,
  MessageSquare,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { conversationIdOf, folderIdOf } from "./storage";

/**
 * One workspace root = a **collapsible section**: a header (chevron + name +
 * create buttons) with its file tree shown beneath **only when expanded**.
 * Folders (`folder:<id>`) may also render nested folder rows (`nested`) and a
 * `folderRail` (flat AgentCore entries) above the file tree.
 *
 * - `conv:<id>` **云** scratch：右键可打开/重命名/删除对话、清空本对话产物。
 * - `conv:<id>` **本地** scratch：无根级清空（树内单删 / 删对话）。
 * - `folder:<id>` 文件夹：右键可重命名 / 「删除文件夹」（与侧栏 {@link WorkspaceGroupHeader}
 *   同构）；无清空。
 */
export function WorkspaceSection({
  ws,
  source,
  activePath,
  expanded,
  onToggle,
  onOpenFile,
  flashing,
  folderRail,
  nested,
  depth = 0,
  hideRootDirs,
  onCreateSubfolder,
  showLocationBadge = true,
  offlineCloud = false,
  filterQuery = "",
}: {
  ws: WorkspaceInfo;
  source: FileSource | null;
  activePath: string | null;
  expanded: boolean;
  onToggle: () => void;
  onOpenFile: (path: string, name: string) => void;
  flashing: boolean;
  /** Folder-only rail children (记忆 → 规则), rendered above the file tree when expanded. */
  folderRail?: ReactNode;
  /** Nested folder rows (我的文件 tree), rendered directly under the header. */
  nested?: ReactNode;
  /** Nesting level inside 我的文件 — indents the header and its tree. */
  depth?: number;
  /** Forwarded to {@link FileTree}: child-folder dirs already shown as rail rows. */
  hideRootDirs?: readonly string[];
  /**
   * Replaces the tree's plain `mkdir` at this root with「在此新建文件夹」, so a
   * folder created at a folder's top level is a real folder (可分组 / 可记忆),
   * not a bare directory the rail cannot address. Receives the trigger element so
   * the cascade opens next to it.
   */
  onCreateSubfolder?: (anchorEl?: Element | null) => void;
  /** Off inside 我的文件 / 本机文件夹 — the section header already says which. */
  showLocationBadge?: boolean;
  /** N4-A: cloud workspace while read-only offline — grey + hint, keep visible. */
  offlineCloud?: boolean;
  /** Forwarded to {@link FileTree} for path/name filter (hub search box). */
  filterQuery?: string;
}) {
  const conversationId = conversationIdOf(ws.wsId);
  const folderId = folderIdOf(ws.wsId);
  const isLocal = ws.location === "local";
  const localUnavailable = isLocal && !source && !offlineCloud;
  const navigate = useNavigate();

  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<FileTreeHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);
  const [pendingAction, setPendingAction] = useState<
    "file" | "dir" | "upload" | null
  >(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteFolderOpen, setDeleteFolderOpen] = useState(false);
  const [clearScratchOpen, setClearScratchOpen] = useState(false);
  const [clearingScratch, setClearingScratch] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ws.name);

  const deleteMutation = useDeleteConversation();
  const renameMutation = useRenameConversation();
  const renameFolderMutation = useUpdateFolder();
  const deleteFolderMutation = useDeleteFolder();
  const permanentDeleteMutation = usePermanentDeleteFolder();
  const restoreFolderMutation = useRestoreFolder();
  const currentId = useConversationStore((s) => s.currentConversationId);
  const dropConversationRuntime = useConversationStore(
    (s) => s.dropConversationRuntime,
  );
  /** Cloud conv scratch only — local/folder roots never get root-level clear. */
  const canClearScratch =
    !!conversationId && !isLocal && !offlineCloud && !!source?.caps.edit;
  /** Cloud workspace only — clone API requires cloud location. */
  const canClone =
    !isLocal &&
    !offlineCloud &&
    !!source?.caps.edit &&
    !ws.wsId.startsWith("shared:");
  const scratchGenerating = useConversationGenerating(conversationId ?? "");

  const folder = folderId
    ? (getFolders().find((f) => f.id === folderId) ?? null)
    : null;
  const folderIsLocal = folder ? deriveGroupWorkspaceIsLocal(folder) : isLocal;

  const liveFolderConvs = () =>
    folderId ? getConversations().filter((c) => c.folderId === folderId) : [];

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

  const requestTreeAction = (
    action: "file" | "dir" | "upload",
    anchorEl?: Element | null,
  ) => {
    if (action === "dir" && onCreateSubfolder) {
      onCreateSubfolder(anchorEl ?? rootRef.current);
      return;
    }
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

  /** Inline rename, for both flavours of root: a `conv:` scratch renames the
   * conversation, a `folder:` row renames the folder itself (§5.4 用户起名). */
  const canRename = !!conversationId || !!folderId;

  const startEdit = () => {
    if (!canRename) return;
    setConfirmingDelete(false);
    setDraft(ws.name);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const name = draft.trim();
    if (!name || name === ws.name) return;
    if (conversationId) {
      renameMutation.mutate(
        { id: conversationId, title: name },
        { onError: (err) => notifyError(err, "重命名失败") },
      );
    } else if (folderId) {
      renameFolderMutation.mutate(
        { id: folderId, patch: { name } },
        { onError: (err) => notifyError(err, "重命名文件夹失败") },
      );
    }
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

  /** Mirrors the sidebar's delete: 撤销 toast raised from the awaited handler,
   * because this section unmounts as soon as the folder is gone. */
  const confirmDeleteFolder = async () => {
    if (!folderId) return;
    const name = folder?.name ?? ws.name;
    try {
      await deleteFolderMutation.mutateAsync(folderId);
    } catch (err) {
      notifyError(err, "删除文件夹失败");
      return;
    }
    setDeleteFolderOpen(false);
    const leftActive = releaseFolderConversations(folderId, {
      dropRuntime: dropConversationRuntime,
      currentId,
    });
    if (leftActive) navigate("/");
    notifyInfo("已删除文件夹", {
      description: name,
      duration: 8000,
      action: {
        label: "撤销",
        onClick: () => restoreFolderMutation.mutate({ id: folderId, name }),
      },
    });
  };

  const confirmPermanentDeleteFolder = () => {
    if (!folderId) return;
    for (const { id } of liveFolderConvs()) {
      dropConversationRuntime(id);
      if (id === currentId) navigate("/");
    }
    permanentDeleteMutation.mutate(folderId, {
      onSuccess: () => setDeleteFolderOpen(false),
      onError: (err) => notifyError(err, "彻底删除失败"),
    });
  };

  /** Cloud conv scratch only: wipe top-level entries; root itself stays. */
  const confirmClearScratch = async () => {
    if (!source || !conversationId || isLocal) return;
    if (scratchGenerating) {
      notifyError("对话进行中，无法清空产物");
      return;
    }
    setClearingScratch(true);
    try {
      const items = await source.listDir("");
      for (const item of items) {
        await source.delete(item.path);
      }
      // Empty cloud scratch drops off GET /v1/workspaces.
      removeConversationScratch(conversationId);
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
      treeRef.current?.refresh();
      setClearScratchOpen(false);
    } catch (e) {
      notifyActionError("清空失败", e);
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
    } finally {
      setClearingScratch(false);
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
        style={{ marginLeft: depth * 12 }}
        className="h-7 min-w-0 flex-1 bg-transparent px-1 text-sm focus:outline-none"
        aria-label={folderId ? "重命名文件夹" : "重命名对话"}
      />
    </div>
  ) : (
    <div
      className={cn(
        "group flex items-center rounded-lg pr-1 text-sm",
        flashing && "ring-2 ring-inset ring-primary",
        offlineCloud && "opacity-60",
      )}
    >
      <Button
        variant="ghost"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{ paddingLeft: 8 + depth * 12 }}
        className="h-auto min-h-9 min-w-0 flex-1 justify-start gap-1.5 overflow-hidden rounded-none py-1.5 pr-0 text-left text-sm font-medium"
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
        source?.caps.edit && (
          <div className="hidden shrink-0 items-center group-hover:flex">
            <IconButton
              title="新建文件"
              onClick={() => requestTreeAction("file")}
            >
              <FilePlus size={14} />
            </IconButton>
            <IconButton
              title={onCreateSubfolder ? "在此新建文件夹" : "新建文件夹"}
              onClick={(e) => requestTreeAction("dir", e.currentTarget)}
            >
              <FolderPlus size={14} />
            </IconButton>
          </div>
        )
      )}
      {showLocationBadge && (
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
      )}
    </div>
  );

  const hintStyle = { paddingLeft: 28 + depth * 12 };
  const tree = offlineCloud ? (
    <div className="py-1 text-xs text-muted-foreground" style={hintStyle}>
      离线时云端文件不可用；本机文件夹可浏览（只读），恢复连接后再改文件。
    </div>
  ) : localUnavailable ? (
    <div className="py-1 text-xs text-muted-foreground/70" style={hintStyle}>
      本机文件夹里的文件在你电脑上，请在桌面端查看。
    </div>
  ) : source ? (
    <FileTree
      ref={treeRef}
      source={source}
      chrome={false}
      indent={14 + depth * 12}
      activePath={activePath}
      filterQuery={filterQuery}
      hideRootDirs={hideRootDirs}
      onOpenFile={onOpenFile}
      emptyText="还没有文件——对话里 AI 产出的文件会落在这里"
    />
  ) : (
    <div className="py-1 text-xs text-muted-foreground/70" style={hintStyle}>
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
            {!localUnavailable && !offlineCloud && source?.caps.edit && (
              <>
                <ContextMenuItem onSelect={() => requestTreeAction("file")}>
                  <FilePlus size={14} className="shrink-0" />
                  <span className="flex-1 truncate">新建文件</span>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => requestTreeAction("dir")}>
                  <FolderPlus size={14} className="shrink-0" />
                  <span className="flex-1 truncate">
                    {onCreateSubfolder ? "在此新建文件夹" : "新建文件夹"}
                  </span>
                </ContextMenuItem>
                {source.caps.transfer && (
                  <ContextMenuItem onSelect={() => requestTreeAction("upload")}>
                    <Upload size={14} className="shrink-0" />
                    <span className="flex-1 truncate">上传文件</span>
                  </ContextMenuItem>
                )}
                {canClone && (
                  <ContextMenuItem onSelect={() => setCloneOpen(true)}>
                    <GitBranch size={14} className="shrink-0" />
                    <span className="flex-1 truncate">克隆仓库</span>
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
            {canClearScratch && (
              <ContextMenuItem
                variant="danger"
                disabled={scratchGenerating}
                onSelect={() => setClearScratchOpen(true)}
              >
                <Eraser size={14} className="shrink-0" />
                <span className="flex-1 truncate">
                  {scratchGenerating
                    ? "清空本对话产物（对话进行中）"
                    : "清空本对话产物…"}
                </span>
              </ContextMenuItem>
            )}
            {canRename && (
              <ContextMenuItem onSelect={startEdit}>
                <Pencil size={14} className="shrink-0" />
                <span className="flex-1 truncate">重命名</span>
              </ContextMenuItem>
            )}
            {conversationId && (
              <ContextMenuItem
                variant="danger"
                onSelect={requestDeleteConversation}
              >
                <Trash2 size={14} className="shrink-0" />
                <span className="flex-1 truncate">删除对话</span>
              </ContextMenuItem>
            )}
            {folderId && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="danger"
                  onSelect={() => setDeleteFolderOpen(true)}
                >
                  <Trash2 size={14} className="shrink-0" />
                  <span className="flex-1 truncate">删除文件夹…</span>
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      )}
      {expanded && (
        <>
          {nested}
          {folderRail}
          {tree}
        </>
      )}
      {folderId && (
        <DeleteFolderDialog
          open={deleteFolderOpen}
          onOpenChange={setDeleteFolderOpen}
          name={folder?.name ?? ws.name}
          liveConvCount={liveFolderConvs().length}
          isLocal={folderIsLocal}
          onConfirm={() => void confirmDeleteFolder()}
          onPermanentConfirm={confirmPermanentDeleteFolder}
        />
      )}
      {canClearScratch && (
        <ClearScratchDialog
          open={clearScratchOpen}
          onOpenChange={setClearScratchOpen}
          name={ws.name}
          busy={clearingScratch}
          onConfirm={() => void confirmClearScratch()}
        />
      )}
      {canClone && (
        <CloneRepoDialog
          open={cloneOpen}
          onOpenChange={setCloneOpen}
          wsId={ws.wsId}
          onCloned={() => treeRef.current?.refresh()}
        />
      )}
    </div>
  );
}
