import { IconButton, SurfaceRow } from "@/components/ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  useArchiveConversation,
  useDeleteConversation,
  useMoveConversation,
  useRenameConversation,
  useTogglePin,
  useUnarchiveConversation,
} from "@/hooks/useConversations";
import { useFolders } from "@/hooks/useFolders";
import { notifyError, notifyInfo } from "@/lib/toast";
import {
  type ExportFormat,
  exportConversation,
} from "@/services/conversations";
import { useApprovalStore } from "@/stores/approvals";
import {
  type Conversation,
  runtimeOf,
  useConversationGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { useShareStore } from "@/stores/share";
import {
  Archive,
  Check,
  Download,
  FileJson,
  Folder,
  Inbox,
  Lock,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Share2,
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
  const [moreOpen, setMoreOpen] = useState(false);
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
  const unarchiveMutation = useUnarchiveConversation();
  const folders = useFolders();
  const isGenerating = useConversationGenerating(conversation.id);
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
  const showRowActions = hovered || confirmingDelete || moreOpen;
  const deleteConfirmLabel = currentFolderId
    ? "确认永久删除（项目文件会保留）"
    : "确认永久删除（无法恢复）";

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
    renameMutation.mutate(
      { id: conversation.id, title },
      { onError: (err) => notifyError(err, "重命名失败") },
    );
  };

  const handleDelete = async () => {
    setConfirmingDelete(false);
    const wasActive = conversation.id === currentId;
    try {
      await deleteMutation.mutateAsync(conversation.id);
    } catch (err) {
      notifyError(err, "删除失败");
      return;
    }
    dropConversationRuntime(conversation.id);
    if (wasActive) navigate("/");
  };

  const togglePin = () => {
    pinMutation.mutate(
      { id: conversation.id, pinned: !conversation.pinned },
      { onError: (err) => notifyError(err, "操作失败") },
    );
  };

  const handleArchive = async () => {
    const wasActive = conversation.id === currentId;
    const title = conversation.title;
    try {
      await archiveMutation.mutateAsync(conversation.id);
    } catch (err) {
      notifyError(err, "归档失败");
      return;
    }
    dropConversationRuntime(conversation.id);
    if (wasActive) navigate("/");
    notifyInfo("已归档", {
      description: title,
      duration: 5000,
      action: {
        label: "撤销",
        onClick: () => {
          unarchiveMutation.mutate(conversation.id, {
            onError: (err) => notifyError(err, "取消归档失败"),
          });
        },
      },
    });
  };

  const moveTo = (folderId: string | null) => {
    if (folderId === currentFolderId) return;
    moveMutation.mutate({ id: conversation.id, folderId });
  };

  const handleExport = async (format: ExportFormat) => {
    try {
      await exportConversation(conversation.id, format);
    } catch (err) {
      notifyError(err, "导出失败");
    }
  };

  const requestPermanentDelete = () => {
    setMoreOpen(false);
    setConfirmingDelete(true);
  };

  const openConversation = () => {
    switchConversation(conversation.id);
    navigate(`/conversations/${conversation.id}`);
  };

  const rowActionClass =
    "size-6 text-sidebar-foreground/40 hover:text-sidebar-foreground";

  const moveMenuSection = workspaceLocked ? (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled>
        <Lock size={14} className="shrink-0" />
        <span className="flex-1 truncate">开始后不可更换工作区</span>
      </DropdownMenuItem>
    </>
  ) : folders.length > 0 || currentFolderId ? (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>移到</DropdownMenuLabel>
      <div className="max-h-52 overflow-y-auto">
        {folders.map((f) => (
          <DropdownMenuItem key={f.id} onSelect={() => void moveTo(f.id)}>
            <Folder size={14} className="shrink-0" />
            <span className="flex-1 truncate">{f.name}</span>
            {f.id === currentFolderId && (
              <Check size={13} className="shrink-0" />
            )}
          </DropdownMenuItem>
        ))}
      </div>
      {currentFolderId && (
        <DropdownMenuItem onSelect={() => void moveTo(null)}>
          <Inbox size={14} className="shrink-0" />
          <span className="flex-1 truncate">移出文件夹</span>
        </DropdownMenuItem>
      )}
    </>
  ) : null;

  const contextMoveSection = workspaceLocked ? (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem disabled>
        <Lock size={14} className="shrink-0" />
        <span className="flex-1 truncate">开始后不可更换工作区</span>
      </ContextMenuItem>
    </>
  ) : folders.length > 0 || currentFolderId ? (
    <>
      <ContextMenuSeparator />
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
    </>
  ) : null;

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
        <SurfaceRow
          variant="sidebar"
          active={isActive}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => {
            setHovered(false);
            if (!moreOpen) setConfirmingDelete(false);
          }}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: 行内另有 DropdownMenuTrigger 的真 <button>，此可点击区不可套 <button>。 */}
          <div
            role="button"
            tabIndex={0}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={openConversation}
            onDoubleClick={(e) => {
              e.preventDefault();
              startEdit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openConversation();
              }
            }}
          >
            {status && (
              <SimpleTooltip label={status === "running" ? "执行中" : "待审批"}>
                <span
                  aria-label={status === "running" ? "执行中" : "待审批"}
                  className={`size-1.5 shrink-0 rounded-full ${
                    status === "running"
                      ? "animate-pulse bg-primary"
                      : "bg-primary"
                  }`}
                />
              </SimpleTooltip>
            )}
            <span className="truncate">{conversation.title}</span>
          </div>
          {confirmingDelete ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <SimpleTooltip label={deleteConfirmLabel}>
                <IconButton
                  tone="sidebar"
                  aria-label={deleteConfirmLabel}
                  className="size-6 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete();
                  }}
                >
                  <Check size={13} />
                </IconButton>
              </SimpleTooltip>
              <SimpleTooltip label="取消">
                <IconButton
                  tone="sidebar"
                  aria-label="取消"
                  className={rowActionClass}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingDelete(false);
                  }}
                >
                  <X size={13} />
                </IconButton>
              </SimpleTooltip>
            </span>
          ) : showRowActions ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <SimpleTooltip label="重命名">
                <IconButton
                  tone="sidebar"
                  aria-label="重命名"
                  className={rowActionClass}
                  onClick={(e) => {
                    e.stopPropagation();
                    startEdit();
                  }}
                >
                  <Pencil size={13} />
                </IconButton>
              </SimpleTooltip>
              <SimpleTooltip label="归档">
                <IconButton
                  tone="sidebar"
                  aria-label="归档"
                  className={rowActionClass}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleArchive();
                  }}
                >
                  <Archive size={13} />
                </IconButton>
              </SimpleTooltip>
              <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    tone="sidebar"
                    aria-label="更多操作"
                    title="更多"
                    className={rowActionClass}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal size={13} />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="min-w-52"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DropdownMenuItem onSelect={() => togglePin()}>
                    {conversation.pinned ? (
                      <PinOff size={14} className="shrink-0" />
                    ) : (
                      <Pin size={14} className="shrink-0" />
                    )}
                    <span className="flex-1 truncate">
                      {conversation.pinned ? "取消置顶" : "置顶"}
                    </span>
                  </DropdownMenuItem>
                  {moveMenuSection}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      useShareStore.getState().open(conversation.id)
                    }
                  >
                    <Share2 size={14} className="shrink-0" />
                    <span className="flex-1 truncate">分享…</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleExport("md")}>
                    <Download size={14} className="shrink-0" />
                    <span className="flex-1 truncate">导出 Markdown</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleExport("json")}>
                    <FileJson size={14} className="shrink-0" />
                    <span className="flex-1 truncate">导出 JSON</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="danger"
                    onSelect={requestPermanentDelete}
                  >
                    <Trash2 size={14} className="shrink-0" />
                    <span className="flex-1 truncate">永久删除</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          ) : conversation.pinned ? (
            <Pin
              size={12}
              className="shrink-0 text-sidebar-foreground/40"
              aria-label="已置顶"
            />
          ) : null}
        </SurfaceRow>
      </ContextMenuTrigger>

      <ContextMenuContent className="min-w-52">
        <ContextMenuItem onSelect={() => startEdit()}>
          <Pencil size={14} className="shrink-0" />
          <span className="flex-1 truncate">重命名</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void handleArchive()}>
          <Archive size={14} className="shrink-0" />
          <span className="flex-1 truncate">归档</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
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
        {contextMoveSection}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => useShareStore.getState().open(conversation.id)}
        >
          <Share2 size={14} className="shrink-0" />
          <span className="flex-1 truncate">分享…</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void handleExport("md")}>
          <Download size={14} className="shrink-0" />
          <span className="flex-1 truncate">导出 Markdown</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void handleExport("json")}>
          <FileJson size={14} className="shrink-0" />
          <span className="flex-1 truncate">导出 JSON</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="danger" onSelect={requestPermanentDelete}>
          <Trash2 size={14} className="shrink-0" />
          <span className="flex-1 truncate">永久删除</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
