import { ConversationItem } from "@/components/sidebar/ConversationItem";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useConversations } from "@/hooks/useConversations";
import {
  useCreateFolder,
  useDeleteFolder,
  useFolders,
  useUpdateFolder,
} from "@/hooks/useFolders";
import type { FolderMeta } from "@/services/folders";
import { type Conversation, useConversationStore } from "@/stores/conversation";
import { UNGROUPED_KEY, useFoldersStore } from "@/stores/folders";
import {
  Check,
  Folder as FolderIcon,
  FolderPlus,
  HardDrive,
  Inbox,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** Synthetic left-pane filter key for「全部对话」(not a real folder). */
const ALL_KEY = "__all__";

function byRecency(a: Conversation, b: Conversation): number {
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
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const folders = useFolders();
  const createFolderMutation = useCreateFolder();
  const setPendingRename = useFoldersStore((s) => s.setPendingRename);
  const setPendingNewChatFolder = useFoldersStore(
    (s) => s.setPendingNewChatFolder,
  );
  const navigate = useNavigate();
  const location = useLocation();

  const [selected, setSelected] = useState<string>(ALL_KEY);
  const [query, setQuery] = useState("");
  const [flashId, setFlashId] = useState<string | null>(null);

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
  // to 全部对话 so the right pane never points at a vanished folder.
  useEffect(() => {
    if (selected === ALL_KEY || selected === UNGROUPED_KEY) return;
    if (!folderIds.has(selected)) setSelected(ALL_KEY);
  }, [folderIds, selected]);

  const list = useMemo(() => {
    const base = conversations.filter((c) => {
      if (selected === ALL_KEY) return true;
      if (selected === UNGROUPED_KEY)
        return !c.folderId || !folderIds.has(c.folderId);
      return c.folderId === selected;
    });
    const q = query.trim().toLowerCase();
    const filtered = q
      ? base.filter((c) => c.title.toLowerCase().includes(q))
      : base;
    return [...filtered].sort(byRecency);
  }, [conversations, selected, query, folderIds]);

  const activeName =
    selected === ALL_KEY
      ? "全部对话"
      : selected === UNGROUPED_KEY
        ? "未分组"
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
    setPendingNewChatFolder(folderTarget);
    switchConversation(null);
    navigate("/");
  };

  const handleNewFolder = async () => {
    try {
      const folder = await createFolderMutation.mutateAsync({
        name: "新建文件夹",
      });
      setSelected(folder.id);
      setPendingRename(folder.id); // its row opens straight into rename mode
    } catch {
      /* create failed (offline / 401); leave the page as-is */
    }
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
                  onDeleted={() => {
                    if (selected === f.id) setSelected(ALL_KEY);
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => void handleNewFolder()}
              className="mt-2 flex h-9 shrink-0 items-center gap-2 rounded-lg border border-dashed border-border px-3 text-sm text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            >
              <FolderPlus size={16} className="shrink-0" />
              新建文件夹
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
                      : conversations.length === 0
                        ? "暂无对话"
                        : "此文件夹暂无对话"}
                  </p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {list.map((c) => (
                    <ConversationItem key={c.id} conversation={c} />
                  ))}
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

/** A real-folder filter row: select to filter, hover for rename/delete. Deleting
 * a folder unbinds its conversations (they drop into 未分组), mirroring the old
 * sidebar FolderGroup contract. */
function FolderFilterRow({
  folder,
  count,
  selected,
  flashing,
  onSelect,
  onDeleted,
}: {
  folder: FolderMeta;
  count: number;
  selected: boolean;
  flashing: boolean;
  onSelect: () => void;
  onDeleted: () => void;
}) {
  const updateFolderMutation = useUpdateFolder();
  const deleteFolderMutation = useDeleteFolder();
  const pendingRenameId = useFoldersStore((s) => s.pendingRenameId);
  const setPendingRename = useFoldersStore((s) => s.setPendingRename);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);

  // A folder just created via "新建文件夹" opens straight into rename mode.
  useEffect(() => {
    if (pendingRenameId === folder.id) {
      setDraft(folder.name);
      setEditing(true);
      setPendingRename(null);
    }
  }, [pendingRenameId, folder.id, folder.name, setPendingRename]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRename = () => {
    setEditing(false);
    const name = draft.trim();
    if (!name || name === folder.name) return;
    // Optimistic rename + silent rollback both live in the mutation.
    updateFolderMutation.mutate({ id: folder.id, patch: { name } });
  };

  const handleDelete = async () => {
    setConfirmingDelete(false);
    // The mutation deletes server-side, then unbinds this folder's conversations
    // into 未分组 and drops the folder from the cache.
    try {
      await deleteFolderMutation.mutateAsync(folder.id);
    } catch {
      return;
    }
    onDeleted();
  };

  if (editing) {
    return (
      <div className="flex h-9 items-center rounded-lg bg-accent px-2">
        <FolderIcon size={16} className="mr-2 shrink-0 text-muted-foreground" />
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
          className="h-7 min-w-0 flex-1 bg-transparent text-sm text-accent-foreground focus:outline-none"
        />
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setConfirmingDelete(false);
      }}
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
      {confirmingDelete ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <SimpleTooltip label="确认删除（对话保留）">
            <button
              type="button"
              aria-label="确认删除文件夹"
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
      ) : hovered ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <SimpleTooltip label="重命名">
            <button
              type="button"
              aria-label="重命名文件夹"
              onClick={() => {
                setDraft(folder.name);
                setEditing(true);
              }}
              className="flex size-6 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
            >
              <Pencil size={13} />
            </button>
          </SimpleTooltip>
          <SimpleTooltip label="删除（对话保留）">
            <button
              type="button"
              aria-label="删除文件夹"
              onClick={() => setConfirmingDelete(true)}
              className="flex size-6 items-center justify-center rounded-lg text-muted-foreground hover:text-destructive"
            >
              <Trash2 size={13} />
            </button>
          </SimpleTooltip>
        </span>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground/60">
          {count}
        </span>
      )}
    </div>
  );
}
