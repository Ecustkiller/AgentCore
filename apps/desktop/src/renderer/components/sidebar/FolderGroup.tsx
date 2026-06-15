import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useDeleteFolder, useUpdateFolder } from "@/hooks/useFolders";
import { notifyError } from "@/lib/toast";
import type { FolderMeta } from "@/services/folders";
import { type Conversation, useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import { useSidebarStore } from "@/stores/sidebar";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  HardDrive,
  Inbox,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConversationItem } from "./ConversationItem";

interface Props {
  /** The folder this section represents, or null for the synthetic ungrouped one. */
  folder: FolderMeta | null;
  collapseKey: string;
  items: Conversation[];
}

export function FolderGroup({ folder, collapseKey, items }: Props) {
  // Section collapse lives in the sidebar store (expandedSections/toggleSection).
  // Default to open so conversations stay visible on first load.
  const open = useSidebarStore((s) => s.expandedSections[collapseKey] ?? true);
  const toggleSection = useSidebarStore((s) => s.toggleSection);
  const updateFolderMutation = useUpdateFolder();
  const deleteFolderMutation = useDeleteFolder();
  const pendingRenameId = useFoldersStore((s) => s.pendingRenameId);
  const setPendingRename = useFoldersStore((s) => s.setPendingRename);
  const setPendingNewChatFolder = useFoldersStore(
    (s) => s.setPendingNewChatFolder,
  );
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder?.name ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);

  const isReal = folder !== null;

  // A folder just created via "新建文件夹…" opens straight into rename mode.
  useEffect(() => {
    if (folder && pendingRenameId === folder.id) {
      setDraft(folder.name);
      setEditing(true);
      setPendingRename(null);
    }
  }, [folder, pendingRenameId, setPendingRename]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRename = () => {
    setEditing(false);
    if (!folder) return;
    const name = draft.trim();
    if (!name || name === folder.name) return;
    // Optimistic rename + rollback live in the mutation; the toast is the only
    // view-specific bit, so it rides along as a call-level onError.
    updateFolderMutation.mutate(
      { id: folder.id, patch: { name } },
      { onError: (err) => notifyError(err, "重命名失败") },
    );
  };

  const handleDelete = async () => {
    setConfirmingDelete(false);
    if (!folder) return;
    // The mutation deletes server-side, then drops this folder's conversations
    // into 未分组 and removes the folder from the cache (so both delete sites
    // share that unbind logic).
    try {
      await deleteFolderMutation.mutateAsync(folder.id);
    } catch (err) {
      notifyError(err, "删除文件夹失败");
    }
  };

  const newChatHere = () => {
    if (!folder) return;
    // Start a draft and remember the target folder; MessageInput files the
    // conversation here when the first message creates it server-side.
    setPendingNewChatFolder(folder.id);
    switchConversation(null);
    navigate("/");
  };

  const startRename = () => {
    if (!folder) return;
    setDraft(folder.name);
    setEditing(true);
  };

  // Inline rename editor replaces the header row.
  if (editing && folder) {
    return (
      <div className="mb-1">
        <div className="flex h-7 items-center rounded-lg bg-sidebar-accent px-2">
          <FolderIcon
            size={14}
            className="mr-1.5 shrink-0 text-sidebar-foreground/50"
          />
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
            className="h-6 min-w-0 flex-1 bg-transparent text-xs font-medium text-sidebar-accent-foreground focus:outline-none"
          />
        </div>
      </div>
    );
  }

  const Chevron = open ? ChevronDown : ChevronRight;

  const header = (
    <div className="group/header flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-sidebar-foreground/50 hover:bg-sidebar-accent/40">
      <button
        type="button"
        onClick={() => toggleSection(collapseKey)}
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
      >
        <Chevron size={13} className="shrink-0" />
        {isReal ? (
          <FolderIcon size={13} className="shrink-0" />
        ) : (
          <Inbox size={13} className="shrink-0" />
        )}
        <span className="truncate">{folder ? folder.name : "未分组"}</span>
        {folder?.localRootId && (
          <HardDrive
            size={11}
            className="shrink-0 text-primary"
            aria-label="本地工作区"
          />
        )}
        <span className="shrink-0 text-sidebar-foreground/30">
          {items.length}
        </span>
      </button>

      {isReal &&
        (confirmingDelete ? (
          <span className="flex shrink-0 items-center gap-0.5">
            <SimpleTooltip label="确认删除（对话保留）">
              <button
                type="button"
                aria-label="确认删除文件夹"
                onClick={() => void handleDelete()}
                className="flex size-5 items-center justify-center rounded text-destructive hover:bg-destructive/10"
              >
                <Check size={12} />
              </button>
            </SimpleTooltip>
            <SimpleTooltip label="取消">
              <button
                type="button"
                aria-label="取消删除"
                onClick={() => setConfirmingDelete(false)}
                className="flex size-5 items-center justify-center rounded text-sidebar-foreground/40 hover:text-sidebar-foreground"
              >
                <X size={12} />
              </button>
            </SimpleTooltip>
          </span>
        ) : (
          <DropdownMenu>
            <SimpleTooltip label="更多">
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="文件夹操作"
                  className="flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/0 transition-colors group-hover/header:text-sidebar-foreground/50 hover:!text-sidebar-foreground data-[state=open]:text-sidebar-foreground/50"
                >
                  <MoreHorizontal size={14} />
                </button>
              </DropdownMenuTrigger>
            </SimpleTooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={startRename}>
                <Pencil size={14} className="shrink-0" />
                <span className="flex-1 truncate">重命名</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={newChatHere}>
                <Plus size={14} className="shrink-0" />
                <span className="flex-1 truncate">新建对话</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="danger"
                onSelect={() => setConfirmingDelete(true)}
              >
                <Trash2 size={14} className="shrink-0" />
                <span className="flex-1 truncate">删除文件夹</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
    </div>
  );

  return (
    <div className="mb-1 rounded-lg">
      {isReal && folder ? (
        <ContextMenu
          onOpenChange={(o) => {
            if (o) setConfirmingDelete(false);
          }}
        >
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={startRename}>
              <Pencil size={14} className="shrink-0" />
              <span className="flex-1 truncate">重命名</span>
            </ContextMenuItem>
            <ContextMenuItem onSelect={newChatHere}>
              <Plus size={14} className="shrink-0" />
              <span className="flex-1 truncate">新建对话</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="danger"
              onSelect={() => setConfirmingDelete(true)}
            >
              <Trash2 size={14} className="shrink-0" />
              <span className="flex-1 truncate">删除文件夹</span>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        header
      )}

      {open && (
        <div className="space-y-0.5 pl-1">
          {items.map((conv) => (
            <ConversationItem key={conv.id} conversation={conv} />
          ))}
          {items.length === 0 && (
            <p className="px-3 py-1 text-xs text-sidebar-foreground/30">
              拖拽或右键对话移入
            </p>
          )}
        </div>
      )}
    </div>
  );
}
