import { ConversationItem } from "@/components/sidebar/ConversationItem";
import {
  Button,
  IconButton,
  SearchField,
  SurfaceRowButton,
} from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  useDeleteConversation,
  useUnarchiveConversation,
} from "@/hooks/useConversations";
import { deriveGroupWorkspaceIsLocal } from "@/lib/conversationWorkspaceMode";
import { startNewConversation } from "@/lib/newConversation";
import { notifyError } from "@/lib/toast";
import type { FolderMeta } from "@/services/folders";
import { type Conversation, useConversationStore } from "@/stores/conversation";
import { UNGROUPED_KEY } from "@/stores/folders";
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Check,
  CheckSquare,
  Folder as FolderIcon,
  FolderOpen,
  Inbox,
  MessageSquare,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ALL_KEY,
  ARCHIVED_KEY,
  STALE_DAYS,
  activeFilterName,
  filesFocusState,
  firstConversationInFolder,
  isRealFolderFilter,
  newChatFolderTarget,
} from "./constants";
import { useConversationBulkSelect } from "./useConversationBulkSelect";
import {
  useConversationList,
  useConversationRouting,
} from "./useConversationList";

/**
 * Dedicated conversation management page (`/conversations`). The sidebar only
 * keeps a handful of recent chats now; the full list — grouped by folder, with
 * folder CRUD and search — lives here.
 */
export function ConversationsPage() {
  const navigate = useNavigate();
  const { selected, setSelected, flashId, folderIds, folders } =
    useConversationRouting();
  const {
    conversations,
    archived,
    counts,
    list,
    query,
    setQuery,
    staleOnly,
    setStaleOnly,
    isArchivedView,
  } = useConversationList(selected, folderIds);
  const bulk = useConversationBulkSelect(list, selected, isArchivedView);

  const folderGroupIsLocal = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const folder of folders) {
      const convs = conversations.filter((c) => c.folderId === folder.id);
      map.set(folder.id, deriveGroupWorkspaceIsLocal(folder));
    }
    return map;
  }, [folders, conversations]);

  const activeName = activeFilterName(selected, folders);
  const isFolderFilter = isRealFolderFilter(selected, folderIds);
  const folderFocusConvId = isFolderFilter
    ? (list[0]?.id ??
      firstConversationInFolder(conversations, selected)?.id ??
      null)
    : null;

  const handleNewChat = () => {
    startNewConversation(navigate, newChatFolderTarget(selected, folderIds));
  };

  return (
    <div className="h-full w-full overflow-hidden">
      <div className="mx-auto flex h-full max-w-[1200px] flex-col px-6 py-8">
        <header className="shrink-0">
          <h1 className="text-xl font-semibold text-foreground">全部对话</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            按文件夹管理你的对话，点击任意对话即可打开
          </p>
        </header>

        <div className="mt-6 flex min-h-0 flex-1 gap-6">
          <aside className="flex w-56 shrink-0 flex-col">
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
              <FilterRow
                icon={<MessageSquare size={16} />}
                label="全部对话"
                count={conversations.length}
                selected={selected === ALL_KEY}
                onSelect={() => setSelected(ALL_KEY)}
              />
              <FilterRow
                icon={<Inbox size={16} />}
                label="未分组"
                count={counts.ungrouped}
                selected={selected === UNGROUPED_KEY}
                onSelect={() => setSelected(UNGROUPED_KEY)}
              />
              <FilterRow
                icon={<Archive size={16} />}
                label="已归档"
                count={archived.length}
                selected={selected === ARCHIVED_KEY}
                onSelect={() => setSelected(ARCHIVED_KEY)}
              />
              {folders.length > 0 && (
                <div className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground/70">
                  文件夹
                </div>
              )}
              {folders.map((f) => (
                <FolderFilterRow
                  key={f.id}
                  folder={f}
                  count={counts.perFolder.get(f.id) ?? 0}
                  firstConvId={
                    firstConversationInFolder(conversations, f.id)?.id ?? null
                  }
                  selected={selected === f.id}
                  flashing={flashId === f.id}
                  onSelect={() => setSelected(f.id)}
                />
              ))}
            </div>
            <SurfaceRowButton
              variant="settings"
              onClick={() => navigate("/files")}
              className="mt-2 shrink-0 justify-start gap-2 border border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            >
              <FolderOpen size={16} className="shrink-0" />
              管理文件夹
            </SurfaceRowButton>
          </aside>

          <section className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <SearchField
                size="md"
                value={query}
                onValueChange={setQuery}
                placeholder={`在「${activeName}」中筛选…`}
                aria-label={`在「${activeName}」中筛选对话`}
                className="min-w-[12rem] flex-1"
              />
              {!isArchivedView && (
                <Button
                  variant={staleOnly ? "primary" : "neutral"}
                  className="h-9 shrink-0"
                  onClick={() => setStaleOnly((v) => !v)}
                >
                  {STALE_DAYS} 天未活跃
                </Button>
              )}
              <Button
                variant={bulk.selectMode ? "primary" : "neutral"}
                className="h-9 shrink-0"
                icon={
                  bulk.selectMode ? (
                    <CheckSquare size={16} className="shrink-0" />
                  ) : undefined
                }
                onClick={() =>
                  bulk.selectMode
                    ? bulk.exitSelectMode()
                    : bulk.setSelectMode(true)
                }
              >
                {bulk.selectMode ? "取消选择" : "选择"}
              </Button>
              <Button
                className="h-9 shrink-0"
                icon={<Plus size={16} className="shrink-0" />}
                onClick={handleNewChat}
              >
                新建对话
              </Button>
            </div>

            {bulk.selectMode && list.length > 0 && (
              <Button
                variant="ghost"
                onClick={bulk.toggleSelectAll}
                className="mt-2 h-8 gap-2 text-sm text-muted-foreground hover:text-foreground"
                icon={
                  bulk.allVisibleSelected ? (
                    <CheckSquare size={15} className="shrink-0" />
                  ) : (
                    <span className="flex size-[15px] shrink-0 items-center justify-center rounded border border-border" />
                  )
                }
              >
                {bulk.allVisibleSelected ? "取消全选" : "全选当前列表"}
              </Button>
            )}

            {isFolderFilter && (
              <SurfaceRowButton
                variant="default"
                onClick={() =>
                  navigate("/files", filesFocusState(folderFocusConvId))
                }
                className="mt-3 w-full shrink-0 justify-start gap-2 border border-border bg-muted/30 px-3 py-2 text-foreground hover:border-foreground/30 hover:bg-accent/60"
              >
                <FolderOpen
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">
                  浏览「{activeName}」的文件
                </span>
                <ArrowRight
                  size={15}
                  className="shrink-0 text-muted-foreground"
                />
              </SurfaceRowButton>
            )}

            {isFolderFilter && (
              <p className="mt-2 shrink-0 text-xs text-muted-foreground">
                整理聊天请用「归档」或「选择」批量归档；删除整个项目请前往{" "}
                <Button
                  variant="ghost"
                  className="inline h-auto p-0 text-foreground underline-offset-2 hover:underline"
                  onClick={() =>
                    navigate("/files", filesFocusState(folderFocusConvId))
                  }
                >
                  文件页
                </Button>
                。
              </p>
            )}

            <div className="relative mt-3 min-h-0 flex-1 overflow-y-auto">
              {list.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                  <MessageSquare
                    size={28}
                    className="text-muted-foreground/40"
                  />
                  <p className="text-sm text-muted-foreground">
                    {query.trim()
                      ? "未找到匹配的对话"
                      : staleOnly
                        ? `暂无超过 ${STALE_DAYS} 天未活跃的对话`
                        : isArchivedView
                          ? "暂无已归档对话"
                          : conversations.length === 0
                            ? "暂无对话"
                            : "此文件夹暂无对话"}
                  </p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {list.map((c) => (
                    <SelectableRow
                      key={c.id}
                      selectMode={bulk.selectMode}
                      selected={bulk.selectedIds.has(c.id)}
                      onToggle={() => bulk.toggleSelected(c.id)}
                    >
                      {isArchivedView ? (
                        <ArchivedConversationRow conversation={c} />
                      ) : (
                        <ConversationItem
                          conversation={c}
                          groupIsLocal={
                            c.folderId
                              ? folderGroupIsLocal.get(c.folderId)
                              : undefined
                          }
                        />
                      )}
                    </SelectableRow>
                  ))}
                </div>
              )}

              {bulk.selectMode && bulk.selectedIds.size > 0 && (
                <div className="sticky bottom-0 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-sm">
                  <span className="text-sm text-muted-foreground">
                    已选 {bulk.selectedIds.size} 项
                  </span>
                  <span className="flex-1" />
                  {isArchivedView ? (
                    <Button
                      variant="neutral"
                      onClick={bulk.handleBulkUnarchive}
                      icon={<ArchiveRestore size={14} className="shrink-0" />}
                    >
                      取消归档
                    </Button>
                  ) : (
                    <Button
                      variant="neutral"
                      onClick={() => void bulk.handleBulkArchive()}
                      icon={<Archive size={14} className="shrink-0" />}
                    >
                      批量归档
                    </Button>
                  )}
                  {bulk.confirmBulkDelete ? (
                    <>
                      <Button
                        variant="danger"
                        onClick={() => void bulk.handleBulkDelete()}
                      >
                        确认永久删除
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => bulk.setConfirmBulkDelete(false)}
                      >
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="danger"
                      onClick={() => bulk.setConfirmBulkDelete(true)}
                      icon={<Trash2 size={14} className="shrink-0" />}
                    >
                      永久删除
                    </Button>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function SelectableRow({
  selectMode,
  selected,
  onToggle,
  children,
}: {
  selectMode: boolean;
  selected: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (!selectMode) return <>{children}</>;
  return (
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label="选择对话"
        className="size-4 shrink-0 rounded border-border accent-primary"
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function FilterRow({
  icon,
  label,
  count,
  selected,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <SurfaceRowButton
      variant="default"
      onClick={onSelect}
      className={`h-9 w-full items-center gap-2 px-2 ${
        selected
          ? "bg-accent text-accent-foreground"
          : "text-foreground/70 hover:bg-accent/60 hover:text-foreground"
      }`}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate text-left">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground/60">{count}</span>
    </SurfaceRowButton>
  );
}

function FolderFilterRow({
  folder,
  count,
  firstConvId,
  selected,
  flashing,
  onSelect,
}: {
  folder: FolderMeta;
  count: number;
  firstConvId: string | null;
  selected: boolean;
  flashing: boolean;
  onSelect: () => void;
}) {
  const navigate = useNavigate();
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`group flex h-9 items-center gap-1 rounded-lg px-2 transition-shadow ${
        selected
          ? "bg-accent text-accent-foreground"
          : "text-foreground/70 hover:bg-accent/60 hover:text-foreground"
      } ${flashing ? "ring-2 ring-inset ring-primary" : ""}`}
    >
      <SurfaceRowButton
        variant="default"
        onClick={onSelect}
        className="min-w-0 flex-1 justify-start gap-2 bg-transparent px-0 text-inherit hover:bg-transparent"
      >
        <FolderIcon size={16} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-sm">{folder.name}</span>
      </SurfaceRowButton>
      {hovered ? (
        <SimpleTooltip label="浏览文件">
          <IconButton
            aria-label="浏览此文件夹的文件"
            onClick={() => navigate("/files", filesFocusState(firstConvId))}
            className="size-6 shrink-0"
          >
            <FolderOpen size={13} />
          </IconButton>
        </SimpleTooltip>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground/60">
          {count}
        </span>
      )}
    </div>
  );
}

function ArchivedConversationRow({
  conversation,
}: {
  conversation: Conversation;
}) {
  const navigate = useNavigate();
  const unarchiveMutation = useUnarchiveConversation();
  const deleteMutation = useDeleteConversation();
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const dropConversationRuntime = useConversationStore(
    (s) => s.dropConversationRuntime,
  );
  const currentId = useConversationStore((s) => s.currentConversationId);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const open = () => {
    switchConversation(conversation.id);
    navigate(`/conversations/${conversation.id}`);
  };

  const handleUnarchive = () => {
    unarchiveMutation.mutate(conversation.id, {
      onError: (err) => notifyError(err, "取消归档失败"),
    });
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

  return (
    <div
      onMouseLeave={() => setConfirmingDelete(false)}
      className="group flex h-10 items-center gap-2 rounded-lg px-3 text-foreground/70 transition-colors hover:bg-accent/60 hover:text-foreground"
    >
      <SurfaceRowButton
        variant="default"
        onClick={open}
        className="min-w-0 flex-1 justify-start gap-2 bg-transparent px-0 text-inherit hover:bg-transparent"
      >
        <MessageSquare size={15} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-sm">{conversation.title}</span>
      </SurfaceRowButton>
      {confirmingDelete ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <SimpleTooltip label="确认永久删除（无法恢复）">
            <IconButton
              aria-label="确认删除对话"
              onClick={() => void handleDelete()}
              className="size-6 text-destructive hover:bg-destructive/10"
            >
              <Check size={13} />
            </IconButton>
          </SimpleTooltip>
          <SimpleTooltip label="取消">
            <IconButton
              aria-label="取消删除"
              onClick={() => setConfirmingDelete(false)}
              className="size-6"
            >
              <X size={13} />
            </IconButton>
          </SimpleTooltip>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <SimpleTooltip label="取消归档">
            <IconButton
              aria-label="取消归档"
              onClick={handleUnarchive}
              className="size-6"
            >
              <ArchiveRestore size={13} />
            </IconButton>
          </SimpleTooltip>
          <SimpleTooltip label="永久删除">
            <IconButton
              aria-label="永久删除对话"
              onClick={() => setConfirmingDelete(true)}
              className="size-6 hover:text-destructive"
            >
              <Trash2 size={13} />
            </IconButton>
          </SimpleTooltip>
        </span>
      )}
    </div>
  );
}
