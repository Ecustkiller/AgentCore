import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  useArchiveConversation,
  useDeleteConversation,
  useMoveConversation,
  useRenameConversation,
  useTogglePin,
} from "@/hooks/useConversations";
import { useCreateFolder, useFolders } from "@/hooks/useFolders";
import { notifyError } from "@/lib/toast";
import { useApprovalStore } from "@/stores/approvals";
import {
  type Conversation,
  runtimeOf,
  useConversationGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import {
  Archive,
  Check,
  Folder,
  FolderPlus,
  Inbox,
  Lock,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Props {
  conversation: Conversation;
}

export function ConversationItem({ conversation }: Props) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);
  const currentId = useConversationStore((s) => s.currentConversationId);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const dropConversationRuntime = useConversationStore(
    (s) => s.dropConversationRuntime,
  );
  const renameMutation = useRenameConversation();
  const moveMutation = useMoveConversation();
  const deleteMutation = useDeleteConversation();
  const pinMutation = useTogglePin();
  const archiveMutation = useArchiveConversation();
  const createFolderMutation = useCreateFolder();
  const folders = useFolders();
  const isGenerating = useConversationGenerating(conversation.id);
  // A conversation's workspace is fixed once it starts (双模式工作区 §九 ⑩): its
  // folder decides which workspace dir it runs in, so re-filing a started chat
  // would silently switch its workspace. Lock the folder-move actions once it has
  // any messages — the server count (live after a reload) plus this session's live
  // runtime cover both a reloaded chat and one just sent in this session.
  const hasLiveMessages = useConversationStore(
    (s) => runtimeOf(s, conversation.id).messages.length > 0,
  );
  const workspaceLocked = conversation.messageCount > 0 || hasLiveMessages;
  const awaitingApproval = useApprovalStore((s) =>
    s.pending.some((p) => p.conversationId === conversation.id),
  );
  const navigate = useNavigate();
  const isActive = conversation.id === currentId;
  const currentFolderId = conversation.folderId ?? null;

  // Sidebar status dot (§七): 待审批 takes priority over 执行中. Both read THIS
  // conversation's own runtime (not the active one), so a background turn that
  // keeps streaming after the user switches away still shows its dot.
  const status: "running" | "awaiting" | null = awaitingApproval
    ? "awaiting"
    : isGenerating
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
    // Optimistic title + rollback live in the mutation; add a toast on failure.
    renameMutation.mutate(
      { id: conversation.id, title },
      { onError: (err) => notifyError(err, "重命名失败") },
    );
  };

  const handleDelete = async () => {
    setConfirmingDelete(false);
    const wasActive = conversation.id === currentId;
    // Delete server-side first so a failed delete leaves the item in place.
    try {
      await deleteMutation.mutateAsync(conversation.id);
    } catch {
      return;
    }
    // The mutation dropped the row from the list cache; forget its live runtime
    // (and clear the current pointer if it was open), then leave the route.
    dropConversationRuntime(conversation.id);
    if (wasActive) navigate("/");
  };

  // Pin / unpin (置顶对话): optimistic + rollback live in the mutation; lists
  // re-sort pinned-first so the row jumps to / from the top at once.
  const togglePin = () => {
    pinMutation.mutate(
      { id: conversation.id, pinned: !conversation.pinned },
      { onError: (err) => notifyError(err, "操作失败") },
    );
  };

  // Archive (归档对话): hide from the live list (recoverable from「已归档」). Like
  // delete, leave the open chat when it was the archived one — the row is gone now.
  const handleArchive = async () => {
    const wasActive = conversation.id === currentId;
    try {
      await archiveMutation.mutateAsync(conversation.id);
    } catch (err) {
      notifyError(err, "归档失败");
      return;
    }
    dropConversationRuntime(conversation.id);
    if (wasActive) navigate("/");
  };

  // Move with an optimistic cache update, rolling back to the previous folder if
  // the server rejects the move (both live in the mutation).
  const moveTo = (folderId: string | null) => {
    if (folderId === currentFolderId) return;
    moveMutation.mutate({ id: conversation.id, folderId });
  };

  const moveToNewFolder = async () => {
    try {
      const folder = await createFolderMutation.mutateAsync({
        name: "新建文件夹",
      });
      // Open the new folder's header in rename mode so the user can name it.
      useFoldersStore.getState().setPendingRename(folder.id);
      moveMutation.mutate({ id: conversation.id, folderId: folder.id });
    } catch {
      /* leave the conversation where it was; the folder create failed */
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
    <ContextMenu
      onOpenChange={(open) => {
        if (open) setConfirmingDelete(false);
      }}
    >
      <ContextMenuTrigger asChild>
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
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => {
            setHovered(false);
            setConfirmingDelete(false);
          }}
        >
          {status && (
            <SimpleTooltip label={status === "running" ? "执行中" : "待审批"}>
              <span
                aria-label={status === "running" ? "执行中" : "待审批"}
                className={`size-1.5 shrink-0 rounded-full ${
                  status === "running"
                    ? "animate-pulse bg-primary"
                    : "bg-warning"
                }`}
              />
            </SimpleTooltip>
          )}
          <span className="flex-1 truncate text-left">
            {conversation.title}
          </span>
          {confirmingDelete ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <SimpleTooltip label="确认删除">
                {/* biome-ignore lint/a11y/useSemanticElements: must remain a span — a real <button> here would nest inside the parent conversation <button>, which is invalid HTML. */}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="确认删除"
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
              </SimpleTooltip>
              <SimpleTooltip label="取消">
                {/* biome-ignore lint/a11y/useSemanticElements: must remain a span — a real <button> here would nest inside the parent conversation <button>, which is invalid HTML. */}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="取消删除"
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
              </SimpleTooltip>
            </span>
          ) : hovered ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <SimpleTooltip label="重命名">
                {/* biome-ignore lint/a11y/useSemanticElements: must remain a span — a real <button> here would nest inside the parent conversation <button>, which is invalid HTML. */}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="重命名对话"
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
              </SimpleTooltip>
              <SimpleTooltip label="删除">
                {/* biome-ignore lint/a11y/useSemanticElements: must remain a span — a real <button> here would nest inside the parent conversation <button>, which is invalid HTML. */}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="删除对话"
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
              </SimpleTooltip>
            </span>
          ) : conversation.pinned ? (
            // Idle + pinned: a quiet pin glyph marks 置顶 (the hover actions and
            // confirm UI take precedence above).
            <Pin
              size={12}
              className="shrink-0 text-sidebar-foreground/40"
              aria-label="已置顶"
            />
          ) : null}
        </button>
      </ContextMenuTrigger>

      <ContextMenuContent className="min-w-52">
        <ContextMenuItem onSelect={() => startEdit()}>
          <Pencil size={14} className="shrink-0" />
          <span className="flex-1 truncate">重命名</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => togglePin()}>
          {conversation.pinned ? (
            <PinOff size={14} className="shrink-0" />
          ) : (
            <Pin size={14} className="shrink-0" />
          )}
          <span className="flex-1 truncate">
            {conversation.pinned ? "取消置顶" : "置顶"}
          </span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {workspaceLocked ? (
          // Started chat: its workspace is pinned to its current folder, so the
          // move actions are replaced by an explanatory locked hint (§九 ⑩).
          <ContextMenuItem disabled>
            <Lock size={14} className="shrink-0" />
            <span className="flex-1 truncate">开始后不可更换工作区</span>
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuLabel>移到</ContextMenuLabel>
            <div className="max-h-52 overflow-y-auto">
              {folders.map((f) => (
                <ContextMenuItem key={f.id} onSelect={() => void moveTo(f.id)}>
                  <Folder size={14} className="shrink-0" />
                  <span className="flex-1 truncate">{f.name}</span>
                  {f.id === currentFolderId && (
                    <Check size={13} className="shrink-0" />
                  )}
                </ContextMenuItem>
              ))}
            </div>
            {currentFolderId && (
              <ContextMenuItem onSelect={() => void moveTo(null)}>
                <Inbox size={14} className="shrink-0" />
                <span className="flex-1 truncate">移出文件夹</span>
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={() => void moveToNewFolder()}>
              <FolderPlus size={14} className="shrink-0" />
              <span className="flex-1 truncate">新建文件夹…</span>
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void handleArchive()}>
          <Archive size={14} className="shrink-0" />
          <span className="flex-1 truncate">归档</span>
        </ContextMenuItem>
        <ContextMenuItem variant="danger" onSelect={() => void handleDelete()}>
          <Trash2 size={14} className="shrink-0" />
          <span className="flex-1 truncate">删除</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
