import {
  type FolderMeta,
  deleteFolder,
  updateFolder,
} from "@/services/folders";
import { type Conversation, useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  Inbox,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ContextMenu, MenuDivider, MenuItem } from "./ContextMenu";
import { ConversationItem } from "./ConversationItem";

interface Props {
  /** The folder this section represents, or null for the synthetic ungrouped one. */
  folder: FolderMeta | null;
  collapseKey: string;
  items: Conversation[];
  /** Force-expanded regardless of stored collapse state (active search). */
  forceOpen?: boolean;
}

export function FolderGroup({ folder, collapseKey, items, forceOpen }: Props) {
  const collapsed = useFoldersStore((s) => s.collapsed[collapseKey] ?? false);
  const toggleCollapsed = useFoldersStore((s) => s.toggleCollapsed);
  const updateFolderMeta = useFoldersStore((s) => s.updateFolderMeta);
  const removeFolder = useFoldersStore((s) => s.removeFolder);
  const pendingRenameId = useFoldersStore((s) => s.pendingRenameId);
  const setPendingRename = useFoldersStore((s) => s.setPendingRename);
  const setPendingNewChatFolder = useFoldersStore(
    (s) => s.setPendingNewChatFolder,
  );
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const setConversationFolder = useConversationStore(
    (s) => s.setConversationFolder,
  );
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder?.name ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);

  const open = forceOpen || !collapsed;
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
    updateFolderMeta(folder.id, { name });
    void updateFolder(folder.id, { name }).catch(() => {
      updateFolderMeta(folder.id, { name: folder.name });
    });
  };

  const handleDelete = async () => {
    setConfirmingDelete(false);
    if (!folder) return;
    try {
      await deleteFolder(folder.id);
    } catch {
      return;
    }
    // The server unbinds this folder's conversations; reflect that locally so
    // they drop into 未分组 without needing a reload.
    for (const c of items) setConversationFolder(c.id, null);
    removeFolder(folder.id);
  };

  const newChatHere = () => {
    setMenuPos(null);
    if (!folder) return;
    // Start a draft and remember the target folder; MessageInput files the
    // conversation here when the first message creates it server-side.
    setPendingNewChatFolder(folder.id);
    switchConversation(null);
    navigate("/");
  };

  const startRename = () => {
    setMenuPos(null);
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

  return (
    <div className="mb-1">
      <div
        className="group/header flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-sidebar-foreground/50 hover:bg-sidebar-accent/40"
        onContextMenu={
          isReal
            ? (e) => {
                e.preventDefault();
                setConfirmingDelete(false);
                setMenuPos({ x: e.clientX, y: e.clientY });
              }
            : undefined
        }
      >
        <button
          type="button"
          onClick={() => toggleCollapsed(collapseKey)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          <Chevron size={13} className="shrink-0" />
          {isReal ? (
            <FolderIcon size={13} className="shrink-0" />
          ) : (
            <Inbox size={13} className="shrink-0" />
          )}
          <span className="truncate">{folder ? folder.name : "未分组"}</span>
          <span className="shrink-0 text-sidebar-foreground/30">
            {items.length}
          </span>
        </button>

        {isReal &&
          (confirmingDelete ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                aria-label="确认删除文件夹"
                title="确认删除（对话保留）"
                onClick={() => void handleDelete()}
                className="flex size-5 items-center justify-center rounded text-destructive hover:bg-destructive/10"
              >
                <Check size={12} />
              </button>
              <button
                type="button"
                aria-label="取消删除"
                title="取消"
                onClick={() => setConfirmingDelete(false)}
                className="flex size-5 items-center justify-center rounded text-sidebar-foreground/40 hover:text-sidebar-foreground"
              >
                <X size={12} />
              </button>
            </span>
          ) : (
            <button
              type="button"
              aria-label="文件夹操作"
              title="更多"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenuPos({ x: r.right, y: r.bottom });
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/0 transition-colors group-hover/header:text-sidebar-foreground/50 hover:!text-sidebar-foreground"
            >
              <MoreHorizontal size={14} />
            </button>
          ))}
      </div>

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

      {menuPos && folder && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => setMenuPos(null)}
        >
          <MenuItem
            icon={<Pencil size={14} />}
            label="重命名"
            onSelect={startRename}
          />
          <MenuItem
            icon={<Plus size={14} />}
            label="新建对话"
            onSelect={newChatHere}
          />
          <MenuDivider />
          <MenuItem
            icon={<Trash2 size={14} />}
            label="删除文件夹"
            danger
            onSelect={() => {
              setMenuPos(null);
              setConfirmingDelete(true);
            }}
          />
        </ContextMenu>
      )}
    </div>
  );
}
