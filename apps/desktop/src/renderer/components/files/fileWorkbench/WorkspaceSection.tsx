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
import type { FileSource } from "@/lib/fileSource";
import { notifyActionError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { WorkspaceInfo } from "@/services/workspaces";
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
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { conversationIdOf } from "./storage";

/**
 * One conversation scratch workspace = a **flat, collapsible section**: a header
 * (chevron + conversation title + cloud/local badge + create buttons) with its file
 * tree shown beneath **only when expanded**. Lifecycle is decoupled from sidebar
 * folders — the context menu opens the owning conversation; file CRUD stays here.
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
  const [pendingAction, setPendingAction] = useState<
    "file" | "dir" | "upload" | null
  >(null);

  useEffect(() => {
    if (flashing) rootRef.current?.scrollIntoView({ block: "nearest" });
  }, [flashing]);

  useEffect(() => {
    if (!expanded || !pendingAction) return;
    if (pendingAction === "upload") treeRef.current?.triggerUpload();
    else treeRef.current?.startCreate(pendingAction);
    setPendingAction(null);
  }, [expanded, pendingAction]);

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
      emptyText="还没有文件——对话里 AI 产出的文件会落在这里"
    />
  ) : (
    <div className="py-1 pl-7 text-xs text-muted-foreground/70">
      无法打开此工作区，文件源暂不可用。
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
        </ContextMenuContent>
      </ContextMenu>
      {expanded && tree}
    </div>
  );
}
