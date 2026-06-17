import { ConversationItem } from "@/components/sidebar/ConversationItem";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  useArchivedConversations,
  useConversations,
  useDeleteConversation,
  useUnarchiveConversation,
} from "@/hooks/useConversations";
import { useFolders } from "@/hooks/useFolders";
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
  Folder as FolderIcon,
  FolderOpen,
  HardDrive,
  Inbox,
  MessageSquare,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** Synthetic left-pane filter key for「全部对话」(not a real folder). */
const ALL_KEY = "__all__";
/** Synthetic left-pane filter key for the「已归档」view (归档对话). */
const ARCHIVED_KEY = "__archived__";

/** Stable empty list so the archived view keeps a constant reference until data. */
const EMPTY_CONVERSATIONS: Conversation[] = [];

function byPinnedThenRecency(a: Conversation, b: Conversation): number {
  // Pinned float to the top (置顶对话); within each group, newest activity first.
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

/**
 * Dedicated conversation management page (`/conversations`). The sidebar only
 * keeps a handful of recent chats now; the full list — grouped by folder, with
 * folder CRUD and search — lives here. Two-pane: a folder filter on the left, a
 * flat recency-sorted conversation list (filtered by the selected folder +
 * search box) on the right. Picking a conversation opens it in the chat view.
 */
export function ConversationsPage() {
  const conversations = useConversations();
  const folders = useFolders();
  const navigate = useNavigate();
  const location = useLocation();

  const [selected, setSelected] = useState<string>(ALL_KEY);
  const [query, setQuery] = useState("");
  const [flashId, setFlashId] = useState<string | null>(null);

  // The「已归档」list is a separate on-demand query (the live grouped cache excludes
  // archived rows). Fetched on this page so its count shows in the left filter and
  // the view is instant when opened (归档对话).
  const isArchivedView = selected === ARCHIVED_KEY;
  const archivedQuery = useArchivedConversations(true);
  const archived = archivedQuery.data ?? EMPTY_CONVERSATIONS;

  // A folder hit from global search (CommandPalette) jumps here, passing the
  // folder id via navigation state. location.key is unique per navigation, so
  // this selects + flashes the target exactly once per jump.
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.key is the intentional per-navigation trigger; state is read off the same navigation.
  useEffect(() => {
    const target = (location.state as { focusFolderId?: string } | null)
      ?.focusFolderId;
    if (!target) return;
    setSelected(target);
    setFlashId(target);
    const t = setTimeout(() => setFlashId(null), 1500);
    return () => clearTimeout(t);
  }, [location.key]);

  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);

  const counts = useMemo(() => {
    let ungrouped = 0;
    const perFolder = new Map<string, number>();
    for (const c of conversations) {
      const fid = c.folderId;
      if (fid && folderIds.has(fid))
        perFolder.set(fid, (perFolder.get(fid) ?? 0) + 1);
      else ungrouped += 1;
    }
    return { ungrouped, perFolder };
  }, [conversations, folderIds]);

  // The selected folder may be deleted (here or by a parallel client); fall back
  // to 全部对话 so the right pane never points at a vanished folder. The synthetic
  // keys (全部 / 未分组 / 已归档) are not folders, so they're exempt.
  useEffect(() => {
    if (
      selected === ALL_KEY ||
      selected === UNGROUPED_KEY ||
      selected === ARCHIVED_KEY
    )
      return;
    if (!folderIds.has(selected)) setSelected(ALL_KEY);
  }, [folderIds, selected]);

  const list = useMemo(() => {
    const base = isArchivedView
      ? archived
      : conversations.filter((c) => {
          if (selected === ALL_KEY) return true;
          if (selected === UNGROUPED_KEY)
            return !c.folderId || !folderIds.has(c.folderId);
          return c.folderId === selected;
        });
    const q = query.trim().toLowerCase();
    const filtered = q
      ? base.filter((c) => c.title.toLowerCase().includes(q))
      : base;
    return [...filtered].sort(byPinnedThenRecency);
  }, [conversations, archived, isArchivedView, selected, query, folderIds]);

  const activeName =
    selected === ALL_KEY
      ? "全部对话"
      : selected === UNGROUPED_KEY
        ? "未分组"
        : selected === ARCHIVED_KEY
          ? "已归档"
          : (folders.find((f) => f.id === selected)?.name ?? "全部对话");

  const handleNewChat = () => {
    // A real selected folder pre-files the draft (MessageInput consumes the
    // pending target on first send); 全部/未分组 start an ungrouped chat.
    const folderTarget =
      selected !== ALL_KEY &&
      selected !== UNGROUPED_KEY &&
      folderIds.has(selected)
        ? selected
        : null;
    startNewConversation(navigate, folderTarget);
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
          {/* Left: folder filter */}
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
                  selected={selected === f.id}
                  flashing={flashId === f.id}
                  onSelect={() => setSelected(f.id)}
                />
              ))}
            </div>
            {/* 文件夹的新建 / 重命名 / 删除 / 添加本地文件夹已统一到「文件」页（文件夹即工
                作区）；这里只做按文件夹筛选，管理入口跳到文件中枢。 */}
            <button
              type="button"
              onClick={() => navigate("/files")}
              className="mt-2 flex h-9 shrink-0 items-center gap-2 rounded-lg border border-dashed border-border px-3 text-sm text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            >
              <FolderOpen size={16} className="shrink-0" />
              管理文件夹
            </button>
          </aside>

          {/* Right: filtered conversation list */}
          <section className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2">
              <div className="relative flex-1">
                <Search
                  size={16}
                  className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 text-muted-foreground"
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`在「${activeName}」中搜索…`}
                  className="h-9 w-full rounded-lg border border-input bg-background pr-3 pl-9 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={handleNewChat}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Plus size={16} className="shrink-0" />
                新建对话
              </button>
            </div>

            {/* 文件夹即工作区: a selected folder is a project, so offer to open its
                workspace overview (files + chats) — the "browse a project's files
                without entering a chat" entry. */}
            {selected !== ALL_KEY &&
              selected !== UNGROUPED_KEY &&
              selected !== ARCHIVED_KEY &&
              folderIds.has(selected) && (
                <button
                  type="button"
                  onClick={() => navigate(`/folders/${selected}`)}
                  className="mt-3 flex w-full shrink-0 items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-left text-sm text-foreground hover:border-foreground/30 hover:bg-accent/60"
                >
                  <FolderOpen
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    打开「{activeName}」工作区 · 浏览文件
                  </span>
                  <ArrowRight
                    size={15}
                    className="shrink-0 text-muted-foreground"
                  />
                </button>
              )}

            <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
              {list.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                  <MessageSquare
                    size={28}
                    className="text-muted-foreground/40"
                  />
                  <p className="text-sm text-muted-foreground">
                    {query.trim()
                      ? "未找到匹配的对话"
                      : isArchivedView
                        ? "暂无已归档对话"
                        : conversations.length === 0
                          ? "暂无对话"
                          : "此文件夹暂无对话"}
                  </p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {list.map((c) =>
                    isArchivedView ? (
                      <ArchivedConversationRow key={c.id} conversation={c} />
                    ) : (
                      <ConversationItem key={c.id} conversation={c} />
                    ),
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

/** A non-folder filter row (全部对话 / 未分组). */
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
    <button
      type="button"
      onClick={onSelect}
      className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm ${
        selected
          ? "bg-accent text-accent-foreground"
          : "text-foreground/70 hover:bg-accent/60 hover:text-foreground"
      }`}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate text-left">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground/60">{count}</span>
    </button>
  );
}

/** A real-folder filter row: select to filter the conversation list; hover to jump
 * to its workspace overview. Folder lifecycle (新建 / 重命名 / 删除 / 添加本地文件夹)
 * lives on the 文件 hub now (文件夹即工作区), so this row is filter-only. */
function FolderFilterRow({
  folder,
  count,
  selected,
  flashing,
  onSelect,
}: {
  folder: FolderMeta;
  count: number;
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
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <FolderIcon size={16} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-sm">{folder.name}</span>
        {folder.localRootId && (
          <HardDrive
            size={12}
            className="shrink-0 text-primary"
            aria-label="本地工作区"
          />
        )}
      </button>
      {hovered ? (
        <SimpleTooltip label="打开工作区">
          <button
            type="button"
            aria-label="打开文件夹工作区"
            onClick={() => navigate(`/folders/${folder.id}`)}
            className="flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
          >
            <FolderOpen size={13} />
          </button>
        </SimpleTooltip>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground/60">
          {count}
        </span>
      )}
    </div>
  );
}

/**
 * One row in the「已归档」view (归档对话). Unlike the live-list {@link ConversationItem}
 * (folder moves + pin + archive), an archived conversation is already out of the
 * sidebar, so its only actions are 取消归档 (restore to the live list) and 删除
 * (permanent). Clicking the row still opens the conversation to read it.
 */
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

  // Restore to the live list: the mutation drops it from this archived view and
  // puts the returned (now-live) row back into the grouped cache.
  const handleUnarchive = () => {
    unarchiveMutation.mutate(conversation.id, {
      onError: (err) => notifyError(err, "取消归档失败"),
    });
  };

  // Permanent (soft) delete, same as the live-list row. If the archived chat is
  // the one currently open, leave the route after it is gone.
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
      <button
        type="button"
        onClick={open}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <MessageSquare size={15} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-sm">{conversation.title}</span>
      </button>
      {confirmingDelete ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <SimpleTooltip label="确认删除">
            <button
              type="button"
              aria-label="确认删除对话"
              onClick={() => void handleDelete()}
              className="flex size-6 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10"
            >
              <Check size={13} />
            </button>
          </SimpleTooltip>
          <SimpleTooltip label="取消">
            <button
              type="button"
              aria-label="取消删除"
              onClick={() => setConfirmingDelete(false)}
              className="flex size-6 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
            >
              <X size={13} />
            </button>
          </SimpleTooltip>
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <SimpleTooltip label="取消归档">
            <button
              type="button"
              aria-label="取消归档"
              onClick={handleUnarchive}
              className="flex size-6 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
            >
              <ArchiveRestore size={13} />
            </button>
          </SimpleTooltip>
          <SimpleTooltip label="删除">
            <button
              type="button"
              aria-label="删除对话"
              onClick={() => setConfirmingDelete(true)}
              className="flex size-6 items-center justify-center rounded-lg text-muted-foreground hover:text-destructive"
            >
              <Trash2 size={13} />
            </button>
          </SimpleTooltip>
        </span>
      )}
    </div>
  );
}
