import { FileTree, type FileTreeHandle } from "@/components/files/FileTree";
import { IconButton } from "@/components/files/parts";
import {
  DeleteProjectDialog,
  archiveConversationsBeforeDelete,
} from "@/components/folders/DeleteProjectDialog";
import { PermanentDeleteProjectDialog } from "@/components/folders/PermanentDeleteProjectDialog";
import { Button } from "@/components/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  useArchiveConversation,
  useConversations,
} from "@/hooks/useConversations";
import { usePermanentDeleteFolder } from "@/hooks/useFolders";
import type { FileSource } from "@/lib/fileSource";
import { notifyActionError, notifyError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { WorkspaceInfo } from "@/services/workspaces";
import { useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import {
  ChevronDown,
  ChevronRight,
  Cloud,
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
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { folderIdOf } from "./storage";

/**
 * One workspace = a **flat, collapsible section**: a header (chevron + name +
 * cloud/local badge + create buttons) with its file tree shown beneath **only when
 * expanded** (`expanded`/`onToggle` owned by the parent so fold state persists +
 * focus can auto-expand). 全部平铺、去掉「home / 其他项目」分区——工作区之间只靠
 * cloud/local 徽标区分（用户 2026-06 决定），且一视同仁（工作区对称化 D1a 起无置顶的默认壳，
 * 每个工作区都可重命名 / 删除 / 查看对话）。Lifecycle (重命名 / 删除 / 查看对话) lives on
 * the right-click menu; 新建 / 上传 are header buttons + menu items —— 折叠时调它们会**先展开
 * 再经 {@link FileTreeHandle} 触发**（pending action，等树挂载好），因为折叠态下树未挂载、ref
 * 为空。一个刚建出的文件夹经共享 `pendingRename` store 直接进内联改名。空态对懒建的本地
 * 工作区（有 `subpath`）用「AI 产物落点」文案，其余用「空文件夹」。
 */
export function WorkspaceSection({
  ws,
  source,
  activePath,
  expanded,
  onToggle,
  onOpenFile,
  onRename,
  onDelete,
  onViewConversations,
  flashing,
}: {
  ws: WorkspaceInfo;
  source: FileSource | null;
  activePath: string | null;
  expanded: boolean;
  onToggle: () => void;
  onOpenFile: (path: string, name: string) => void;
  onRename: (folderId: string, name: string) => void;
  onDelete: (folderId: string) => void;
  onViewConversations: (folderId: string) => void;
  flashing: boolean;
}) {
  const folderId = folderIdOf(ws.wsId);
  const isLocal = ws.location === "local";
  const localUnavailable = isLocal && !source;
  const navigate = useNavigate();
  const archiveMutation = useArchiveConversation();
  const currentId = useConversationStore((s) => s.currentConversationId);
  const dropConversationRuntime = useConversationStore(
    (s) => s.dropConversationRuntime,
  );
  const conversations = useConversations();
  const folderConvs = useMemo(
    () => conversations.filter((c) => c.folderId === folderId),
    [conversations, folderId],
  );
  const liveConvCount = folderConvs.length;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [permanentDeleteOpen, setPermanentDeleteOpen] = useState(false);
  const permanentDeleteMutation = usePermanentDeleteFolder();

  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<FileTreeHandle>(null);
  // 折叠态下点「新建文件 / 文件夹 / 上传」：树未挂载、ref 为空，先暂存动作并展开，等树挂载后再触发。
  const [pendingAction, setPendingAction] = useState<
    "file" | "dir" | "upload" | null
  >(null);

  // 被聚焦（从对话页「浏览文件」跳来）时滚入可视区。
  useEffect(() => {
    if (flashing) rootRef.current?.scrollIntoView({ block: "nearest" });
  }, [flashing]);

  // 展开后兑现暂存的树动作（ref 在 commit 阶段已挂好，effect 里取得到）。
  useEffect(() => {
    if (!expanded || !pendingAction) return;
    if (pendingAction === "upload") treeRef.current?.triggerUpload();
    else treeRef.current?.startCreate(pendingAction);
    setPendingAction(null);
  }, [expanded, pendingAction]);

  // 触发一个树动作：已展开则直接调 ref；折叠则暂存 + 展开，由上面的 effect 兑现。
  const requestTreeAction = (action: "file" | "dir" | "upload") => {
    if (expanded) {
      if (action === "upload") treeRef.current?.triggerUpload();
      else treeRef.current?.startCreate(action);
    } else {
      setPendingAction(action);
      onToggle();
    }
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ws.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);

  const pendingRenameId = useFoldersStore((s) => s.pendingRenameId);
  const setPendingRename = useFoldersStore((s) => s.setPendingRename);

  // 刚经「新建文件夹」建出的工作区：直接进入内联重命名。
  useEffect(() => {
    if (folderId && pendingRenameId === folderId) {
      setDraft(ws.name);
      setEditing(true);
      setPendingRename(null);
    }
  }, [pendingRenameId, folderId, ws.name, setPendingRename]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRename = () => {
    setEditing(false);
    const name = draft.trim();
    if (!folderId || !name || name === ws.name) return;
    onRename(folderId, name);
  };

  const confirmDeleteProject = async ({
    archiveConversations,
  }: {
    archiveConversations: boolean;
  }) => {
    if (!folderId) return;
    if (archiveConversations && folderConvs.length > 0) {
      const ok = await archiveConversationsBeforeDelete(folderConvs, {
        archive: (id) => archiveMutation.mutateAsync(id),
        dropRuntime: dropConversationRuntime,
        currentId,
        onLeaveActive: () => navigate("/"),
      });
      if (!ok) {
        notifyError("归档失败，项目未删除");
        return;
      }
    }
    onDelete(folderId);
    setDeleteOpen(false);
  };

  const confirmPermanentDelete = () => {
    if (!folderId) return;
    for (const { id } of folderConvs) {
      dropConversationRuntime(id);
      if (id === currentId) navigate("/");
    }
    permanentDeleteMutation.mutate(folderId, {
      onSuccess: () => setPermanentDeleteOpen(false),
      onError: (err) => notifyError(err, "彻底删除失败"),
    });
  };

  // 在系统文件管理器中定位整个工作区根（仅本地源——云端无本机路径，方法不存在则不挂入口）。
  const revealRoot = async () => {
    try {
      await source?.revealInOsFileManager?.("");
    } catch (e) {
      notifyActionError("无法在资源管理器中显示", e);
    }
  };

  if (editing) {
    return (
      <div>
        <div className="flex items-center gap-1.5 rounded-lg bg-accent px-2 py-1.5">
          <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
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
              commitRename();
            }}
            className="h-6 min-w-0 flex-1 bg-transparent text-sm text-accent-foreground focus:outline-none"
          />
        </div>
      </div>
    );
  }

  // 平铺标题行：chevron + 名字（点击展开/收起）+ 新建按钮（hover 显形）+ 云端/本地徽标。
  const header = (
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
      {source && (
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
      emptyText={
        ws.subpath ? "还没有文件——对话里 AI 产出的文件会落在这里" : "空文件夹"
      }
    />
  ) : (
    <div className="py-1 pl-7 text-xs text-muted-foreground/70">
      无法打开此项目，文件源暂不可用。
    </div>
  );

  return (
    <div ref={rootRef}>
      <ContextMenu>
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
                  <span className="flex-1 truncate">上传到此项目</span>
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
          <ContextMenuItem
            onSelect={() => {
              setDraft(ws.name);
              setEditing(true);
            }}
          >
            <Pencil size={14} className="shrink-0" />
            <span className="flex-1 truncate">重命名</span>
          </ContextMenuItem>
          {folderId && (
            <ContextMenuItem onSelect={() => onViewConversations(folderId)}>
              <MessageSquare size={14} className="shrink-0" />
              <span className="flex-1 truncate">查看对话</span>
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="danger"
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 size={14} className="shrink-0" />
            <span className="flex-1 truncate">删除项目…</span>
          </ContextMenuItem>
          <ContextMenuItem
            variant="danger"
            onSelect={() => setPermanentDeleteOpen(true)}
          >
            <Trash2 size={14} className="shrink-0" />
            <span className="flex-1 truncate">彻底删除项目…</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <DeleteProjectDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        name={ws.name}
        liveConvCount={liveConvCount}
        onConfirm={confirmDeleteProject}
      />
      <PermanentDeleteProjectDialog
        open={permanentDeleteOpen}
        onOpenChange={setPermanentDeleteOpen}
        name={ws.name}
        liveConvCount={liveConvCount}
        isLocal={isLocal}
        onConfirm={confirmPermanentDelete}
      />
      {expanded && tree}
    </div>
  );
}
