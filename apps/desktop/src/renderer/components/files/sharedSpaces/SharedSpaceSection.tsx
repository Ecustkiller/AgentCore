import { FileTree, type FileTreeHandle } from "@/components/files/FileTree";
import { IconButton } from "@/components/files/parts";
import { CreateSharedSpaceDialog } from "@/components/files/sharedSpaces/CreateSharedSpaceDialog";
import { SharedSpaceEventsDialog } from "@/components/files/sharedSpaces/SharedSpaceEventsDialog";
import { SharedSpaceMembersDialog } from "@/components/files/sharedSpaces/SharedSpaceMembersDialog";
import { CreateFolderCascadePanel } from "@/components/folders/CreateFolderMenu";
import { Button, IconButton as UiIconButton } from "@/components/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useDeleteSharedSpace,
  useRemoveOrLeaveSharedMember,
  useRenameSharedSpace,
} from "@/hooks/useSharedSpaces";
import type { FileSource } from "@/lib/fileSource";
import { notifyError, notifySuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  type SharedSpaceSummary,
  canWriteSharedSpace,
} from "@/services/sharedSpaces";
import { useAuthStore } from "@/stores/auth";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FilePlus,
  FolderOpen,
  FolderPlus,
  History,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * One shared-space root in the files rail — same collapsible section chrome as
 * {@link WorkspaceSection}, plus members / events / leave·delete.
 */
export function SharedSpaceSection({
  space,
  source,
  activePath,
  expanded,
  onToggle,
  onOpenFile,
  flashing,
  offlineUnavailable = false,
  filterQuery = "",
}: {
  space: SharedSpaceSummary;
  source: FileSource | null;
  activePath: string | null;
  expanded: boolean;
  onToggle: () => void;
  onOpenFile: (path: string, name: string) => void;
  flashing: boolean;
  /** N4-A: grey + hint while read-only offline (shared spaces are cloud-only). */
  offlineUnavailable?: boolean;
  /** Forwarded to {@link FileTree} for path/name filter (hub search box). */
  filterQuery?: string;
}) {
  const meId = useAuthStore((s) => s.user?.id ?? null);
  const canWrite = canWriteSharedSpace(space.my_role);
  const isOwner = space.my_role === "owner";

  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<FileTreeHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);
  const [pendingAction, setPendingAction] = useState<
    "file" | "dir" | "upload" | null
  >(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(space.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);

  const rename = useRenameSharedSpace();
  const del = useDeleteSharedSpace();
  const leave = useRemoveOrLeaveSharedMember();

  useEffect(() => {
    if (flashing) rootRef.current?.scrollIntoView({ block: "nearest" });
  }, [flashing]);

  useEffect(() => {
    if (!expanded || !pendingAction || !canWrite) return;
    if (pendingAction === "upload") treeRef.current?.triggerUpload();
    else treeRef.current?.startCreate(pendingAction);
    setPendingAction(null);
  }, [expanded, pendingAction, canWrite]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(space.name);
  }, [space.name, editing]);

  const requestTreeAction = (action: "file" | "dir" | "upload") => {
    if (!canWrite) return;
    if (expanded) {
      if (action === "upload") treeRef.current?.triggerUpload();
      else treeRef.current?.startCreate(action);
    } else {
      setPendingAction(action);
      onToggle();
    }
  };

  const startEdit = () => {
    if (!isOwner) return;
    setConfirmingDelete(false);
    setDraft(space.name);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    if (!isOwner) return;
    const name = draft.trim();
    if (!name || name === space.name) return;
    rename.mutate(
      { spaceId: space.id, name },
      { onError: (err) => notifyError(err, "重命名失败") },
    );
  };

  const handleDeleteOrLeave = () => {
    if (isOwner) {
      if (
        !window.confirm(
          `确定删除共享空间「${space.name}」？所有成员将失去访问，文件不可恢复。`,
        )
      ) {
        return;
      }
      del.mutate(space.id, {
        onSuccess: () => notifySuccess("已删除共享空间"),
        onError: (err) => notifyError(err, "删除失败"),
      });
      return;
    }
    if (!meId) return;
    if (!window.confirm(`确定退出共享空间「${space.name}」？`)) return;
    leave.mutate(
      { spaceId: space.id, memberUserId: meId },
      {
        onSuccess: () => notifySuccess("已退出共享空间"),
        onError: (err) => notifyError(err, "退出失败"),
      },
    );
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
        aria-label="重命名共享空间"
      />
    </div>
  ) : (
    <div
      className={cn(
        "group flex items-center rounded-lg pr-1 text-sm",
        flashing && "ring-2 ring-inset ring-primary",
        offlineUnavailable && "opacity-60",
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
        <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {space.name}
        </span>
      </Button>
      {confirmingDelete ? (
        <div className="flex shrink-0 items-center">
          <IconButton
            title={isOwner ? "确认删除空间" : "确认退出"}
            onClick={() => {
              setConfirmingDelete(false);
              handleDeleteOrLeave();
            }}
          >
            <Check size={14} className="text-destructive" />
          </IconButton>
          <IconButton title="取消" onClick={() => setConfirmingDelete(false)}>
            <X size={14} />
          </IconButton>
        </div>
      ) : (
        canWrite &&
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
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
        <Users size={12} />
        共享
      </span>
    </div>
  );

  const tree = offlineUnavailable ? (
    <div className="py-1 pl-7 text-xs text-muted-foreground">
      离线时共享空间不可用；本机文件夹可浏览（只读），恢复连接后再改文件。
    </div>
  ) : source ? (
    <FileTree
      ref={treeRef}
      source={source}
      chrome={false}
      indent={14}
      activePath={activePath}
      filterQuery={filterQuery}
      onOpenFile={onOpenFile}
      emptyText={
        canWrite
          ? "还没有文件——把产出放进这里，成员就能看到"
          : "还没有文件（只读）"
      }
    />
  ) : (
    <div className="py-1 pl-7 text-xs text-muted-foreground/70">
      无法打开此共享空间，文件源暂不可用。
    </div>
  );

  return (
    <div ref={rootRef}>
      {editing ? (
        header
      ) : (
        <ContextMenu
          onOpenChange={(openMenu) => {
            if (openMenu) setConfirmingDelete(false);
          }}
        >
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent className="min-w-44">
            {canWrite && source && (
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
            <ContextMenuItem onSelect={() => setMembersOpen(true)}>
              <Users size={14} className="shrink-0" />
              <span className="flex-1 truncate">成员管理</span>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => setEventsOpen(true)}>
              <History size={14} className="shrink-0" />
              <span className="flex-1 truncate">变更记录</span>
            </ContextMenuItem>
            {isOwner && (
              <ContextMenuItem onSelect={startEdit}>
                <Pencil size={14} className="shrink-0" />
                <span className="flex-1 truncate">重命名</span>
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="danger"
              onSelect={() => setConfirmingDelete(true)}
            >
              <Trash2 size={14} className="shrink-0" />
              <span className="flex-1 truncate">
                {isOwner ? "删除空间…" : "退出空间…"}
              </span>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {expanded && tree}
      <SharedSpaceMembersDialog
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        spaceId={space.id}
        spaceName={space.name}
        myRole={space.my_role}
      />
      <SharedSpaceEventsDialog
        open={eventsOpen}
        onClose={() => setEventsOpen(false)}
        spaceId={space.id}
        spaceName={space.name}
      />
    </div>
  );
}

/**
 * 「项目」段头：区名 + `+` Popover（新建项目同层 cascade / 新建共享空间 Dialog）。
 * 共享空间已并入项目段混排，不再有独立「共享空间」区头。
 * 与 DraftChip 同构：同一 Popover 内 pick→create 切视图，避免 Dropdown→Host 竞态。
 */
export function ProjectsRailHeader({
  onSharedCreated,
}: {
  onSharedCreated?: (spaceId: string) => void;
}) {
  const [createSharedOpen, setCreateSharedOpen] = useState(false);
  const [pop, setPop] = useState(false);
  const [view, setView] = useState<"pick" | "create">("pick");

  const closePick = () => {
    setPop(false);
    setView("pick");
  };

  return (
    <>
      <div className="flex items-center gap-1 px-2 pb-0.5 pt-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          项目
        </span>
        <Popover
          open={pop}
          onOpenChange={(o) => {
            setPop(o);
            if (!o) setView("pick");
          }}
        >
          <PopoverTrigger asChild>
            <UiIconButton aria-label="新建" title="新建">
              <Plus size={13} />
            </UiIconButton>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            // Keep side when switching pick→create (taller cascade); flip feels like a jump.
            avoidCollisions={false}
            className={view === "create" ? "w-auto p-0" : "min-w-40 p-0"}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {view === "create" ? (
              <div>
                <div className="flex items-center gap-1 border-b border-border px-1 py-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs font-normal text-muted-foreground"
                    onClick={() => setView("pick")}
                  >
                    <ChevronLeft size={14} />
                    新建
                  </Button>
                  <span className="px-1 text-xs font-medium text-foreground">
                    新建云项目
                  </span>
                </div>
                <CreateFolderCascadePanel onClose={closePick} />
              </div>
            ) : (
              <div className="p-1">
                <Button
                  variant="ghost"
                  onClick={() => setView("create")}
                  className="h-auto w-full justify-start gap-2 px-2.5 py-1.5 text-left text-xs font-medium"
                  icon={
                    <FolderPlus
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
                  }
                >
                  <span className="flex-1 truncate">新建云项目</span>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    closePick();
                    setCreateSharedOpen(true);
                  }}
                  className="h-auto w-full justify-start gap-2 px-2.5 py-1.5 text-left text-xs font-medium"
                  icon={
                    <Users
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
                  }
                >
                  <span className="flex-1 truncate">新建共享空间…</span>
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
      <CreateSharedSpaceDialog
        open={createSharedOpen}
        onClose={() => setCreateSharedOpen(false)}
        onCreated={onSharedCreated}
      />
    </>
  );
}
