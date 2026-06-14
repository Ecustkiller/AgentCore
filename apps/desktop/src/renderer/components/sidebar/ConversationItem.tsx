import {
  deleteConversation,
  moveConversation,
  renameConversation,
} from "@/services/conversations";
import { createFolder } from "@/services/folders";
import { useApprovalStore } from "@/stores/approvals";
import { type Conversation, useConversationStore } from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import {
  Check,
  Folder,
  FolderPlus,
  Inbox,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ContextMenu, MenuDivider, MenuItem, MenuLabel } from "./ContextMenu";

interface Props {
  conversation: Conversation;
}

export function ConversationItem({ conversation }: Props) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);
  const currentId = useConversationStore((s) => s.currentConversationId);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const removeConversation = useConversationStore((s) => s.removeConversation);
  const renameInStore = useConversationStore((s) => s.renameConversation);
  const setConversationFolder = useConversationStore(
    (s) => s.setConversationFolder,
  );
  const folders = useFoldersStore((s) => s.folders);
  const isGenerating = useConversationStore((s) => s.isGenerating);
  const awaitingApproval = useApprovalStore((s) =>
    s.pending.some((p) => p.conversationId === conversation.id),
  );
  const navigate = useNavigate();
  const isActive = conversation.id === currentId;
  const currentFolderId = conversation.folderId ?? null;

  // Sidebar status dot (§七): 待审批 takes priority over 执行中; only the active
  // conversation streams in this single-stream app, so 执行中 is gated on it.
  const status: "running" | "awaiting" | null = awaitingApproval
    ? "awaiting"
    : isActive && isGenerating
      ? "running"
      : null;

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    setConfirmingDelete(false);
    setDraft(conversation.title);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const title = draft.trim();
    if (!title || title === conversation.title) return;
    renameInStore(conversation.id, title); // optimistic; reconcile on failure
    void renameConversation(conversation.id, title).catch(() => {
      renameInStore(conversation.id, conversation.title);
    });
  };

  const handleDelete = async () => {
    setConfirmingDelete(false);
    // Delete server-side first so a failed delete leaves the item in place.
    try {
      await deleteConversation(conversation.id);
    } catch {
      return;
    }
    const wasActive = conversation.id === currentId;
    removeConversation(conversation.id);
    if (wasActive) navigate("/");
  };

  // Move with an optimistic store update, rolling back to the previous folder if
  // the server rejects the move.
  const moveTo = async (folderId: string | null) => {
    setMenuPos(null);
    if (folderId === currentFolderId) return;
    setConversationFolder(conversation.id, folderId);
    try {
      await moveConversation(conversation.id, folderId);
    } catch {
      setConversationFolder(conversation.id, currentFolderId);
    }
  };

  const moveToNewFolder = async () => {
    setMenuPos(null);
    try {
      const folder = await createFolder("新建文件夹");
      useFoldersStore.getState().addFolder(folder);
      // Open the new folder's header in rename mode so the user can name it.
      useFoldersStore.getState().setPendingRename(folder.id);
      setConversationFolder(conversation.id, folder.id);
      await moveConversation(conversation.id, folder.id);
    } catch {
      /* leave the conversation where it was; the folder create/move failed */
    }
  };

  if (editing) {
    return (
      <div className="flex h-9 w-full items-center rounded-lg bg-sidebar-accent px-2">
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
          className="h-7 min-w-0 flex-1 bg-transparent px-1 text-sm text-sidebar-accent-foreground focus:outline-none"
        />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`group flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm transition-colors ${
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        }`}
        onClick={() => {
          switchConversation(conversation.id);
          navigate(`/conversations/${conversation.id}`);
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          startEdit();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setConfirmingDelete(false);
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          setConfirmingDelete(false);
        }}
      >
        {status && (
          <span
            aria-label={status === "running" ? "执行中" : "待审批"}
            title={status === "running" ? "执行中" : "待审批"}
            className={`size-1.5 shrink-0 rounded-full ${
              status === "running" ? "animate-pulse bg-primary" : "bg-warning"
            }`}
          />
        )}
        <span className="flex-1 truncate text-left">{conversation.title}</span>
        {confirmingDelete ? (
          <span className="flex shrink-0 items-center gap-0.5">
            {/* biome-ignore lint/a11y/useSemanticElements: must remain a span — a real <button> here would nest inside the parent conversation <button>, which is invalid HTML. */}
            <span
              role="button"
              tabIndex={-1}
              aria-label="确认删除"
              title="确认删除"
              className="flex size-6 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10"
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  void handleDelete();
                }
              }}
              onClick={(e) => {
                e.stopPropagation();
                void handleDelete();
              }}
            >
              <Check size={13} />
            </span>
            {/* biome-ignore lint/a11y/useSemanticElements: must remain a span — a real <button> here would nest inside the parent conversation <button>, which is invalid HTML. */}
            <span
              role="button"
              tabIndex={-1}
              aria-label="取消删除"
              title="取消"
              className="flex size-6 items-center justify-center rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  setConfirmingDelete(false);
                }
              }}
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingDelete(false);
              }}
            >
              <X size={13} />
            </span>
          </span>
        ) : (
          hovered && (
            <span className="flex shrink-0 items-center gap-0.5">
              {/* biome-ignore lint/a11y/useSemanticElements: must remain a span — a real <button> here would nest inside the parent conversation <button>, which is invalid HTML. */}
              <span
                role="button"
                tabIndex={-1}
                aria-label="重命名对话"
                title="重命名"
                className="flex size-6 items-center justify-center rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    startEdit();
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  startEdit();
                }}
              >
                <Pencil size={13} />
              </span>
              {/* biome-ignore lint/a11y/useSemanticElements: must remain a span — a real <button> here would nest inside the parent conversation <button>, which is invalid HTML. */}
              <span
                role="button"
                tabIndex={-1}
                aria-label="删除对话"
                title="删除"
                className="flex size-6 items-center justify-center rounded-lg text-sidebar-foreground/40 hover:text-destructive"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    setConfirmingDelete(true);
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmingDelete(true);
                }}
              >
                <Trash2 size={13} />
              </span>
            </span>
          )
        )}
      </button>
      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => setMenuPos(null)}
        >
          <MenuItem
            icon={<Pencil size={14} />}
            label="重命名"
            onSelect={() => {
              setMenuPos(null);
              startEdit();
            }}
          />
          <MenuDivider />
          <MenuLabel>移到</MenuLabel>
          <div className="max-h-52 overflow-y-auto">
            {folders.map((f) => (
              <MenuItem
                key={f.id}
                icon={<Folder size={14} />}
                label={f.name}
                onSelect={() => void moveTo(f.id)}
                trailing={
                  f.id === currentFolderId ? <Check size={13} /> : undefined
                }
              />
            ))}
          </div>
          {currentFolderId && (
            <MenuItem
              icon={<Inbox size={14} />}
              label="移出文件夹"
              onSelect={() => void moveTo(null)}
            />
          )}
          <MenuItem
            icon={<FolderPlus size={14} />}
            label="新建文件夹…"
            onSelect={() => void moveToNewFolder()}
          />
          <MenuDivider />
          <MenuItem
            icon={<Trash2 size={14} />}
            label="删除"
            danger
            onSelect={() => {
              setMenuPos(null);
              void handleDelete();
            }}
          />
        </ContextMenu>
      )}
    </>
  );
}
