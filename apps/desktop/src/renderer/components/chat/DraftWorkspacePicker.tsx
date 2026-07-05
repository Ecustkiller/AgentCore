import { Button, IconButton, SearchField } from "@/components/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useGroupedConversations } from "@/hooks/useConversations";
import { useCreateFolder } from "@/hooks/useFolders";
import { hasLocalFiles } from "@/lib/capabilities";
import { ensureDefaultContainerRoot } from "@/services/defaultWorkspace";
import type { FolderMeta } from "@/services/folders";
import { useFoldersStore } from "@/stores/folders";
import {
  Check,
  ChevronDown,
  Cloud,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Loader2,
  MessageSquarePlus,
  Pin,
  PinOff,
  X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

// 本地文件能力（web 缺 fsApi → false）
const isDesktop = hasLocalFiles();
const RECENT_WHEN_IDLE = 3;
const SEARCH_RESULT_CAP = 12;

/**
 * 草稿期「对话归属」选择器（双模式工作区 §六 / 前端UX §九）。
 *
 * B3+：默认不选 = 输入框只露轻量「归入项目…」；选了才显示确认 chip。不选 ≡ 旧「自动」
 * （桌面 local-first 懒建），但不再用 Sparkles「自动」占主视觉。落点经 `pendingNewChat*`
 * 传给首发建会话；首发后锁定，改由 `WorkspaceModeBar` 承担。
 */
export function DraftWorkspacePicker() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [pickedRoot, setPickedRoot] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const createFolder = useCreateFolder();

  const grouped = useGroupedConversations().data;
  const folders = useMemo(() => grouped?.folders ?? [], [grouped]);
  const conversations = useMemo(() => grouped?.conversations ?? [], [grouped]);

  const pendingFolderId = useFoldersStore((s) => s.pendingNewChatFolderId);
  const pendingCloud = useFoldersStore((s) => s.pendingNewChatCloud);
  const pinnedFolderIds = useFoldersStore((s) => s.pinnedFolderIds);
  const setFolder = useFoldersStore((s) => s.setPendingNewChatFolder);
  const setCloud = useFoldersStore((s) => s.setPendingNewChatCloud);
  const togglePin = useFoldersStore((s) => s.togglePinFolder);

  const lastActivity = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of conversations) {
      if (!c.folderId) continue;
      const t = Date.parse(c.updatedAt) || 0;
      map.set(c.folderId, Math.max(map.get(c.folderId) ?? 0, t));
    }
    return map;
  }, [conversations]);

  const pinnedFolders = useMemo(
    () =>
      pinnedFolderIds
        .map((id) => folders.find((f) => f.id === id))
        .filter(Boolean) as FolderMeta[],
    [pinnedFolderIds, folders],
  );

  const recentFolders = useMemo(
    () =>
      [...folders]
        .filter((f) => !pinnedFolderIds.includes(f.id))
        .sort(
          (a, b) =>
            (lastActivity.get(b.id) ?? 0) - (lastActivity.get(a.id) ?? 0),
        )
        .slice(0, RECENT_WHEN_IDLE),
    [folders, lastActivity, pinnedFolderIds],
  );

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return [...folders]
      .filter((f) => f.name.toLowerCase().includes(q))
      .sort(
        (a, b) => (lastActivity.get(b.id) ?? 0) - (lastActivity.get(a.id) ?? 0),
      )
      .slice(0, SEARCH_RESULT_CAP);
  }, [query, folders, lastActivity]);

  const isSearching = !!query.trim();

  const selectedFolder = pendingFolderId
    ? (folders.find((f) => f.id === pendingFolderId) ?? null)
    : null;

  const hasSelection = !!selectedFolder || pendingCloud;

  const pickNone = () => {
    setFolder(null);
    setCloud(false);
    if (isDesktop) void ensureDefaultContainerRoot();
    setOpen(false);
  };

  const pickFolder = (id: string) => {
    setFolder(id);
    setCloud(false);
    setOpen(false);
  };

  const pickCloud = () => {
    setFolder(null);
    setCloud(true);
    setOpen(false);
  };

  const clearSelection = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    pickNone();
  };

  const openLocalFolder = () => {
    // Local-first default: no folder grouping; first send sets local_container_root_id.
    pickNone();
    setOpen(false);
  };

  const resetCreateState = () => {
    setCreating(false);
    setNewName("");
    setPickedRoot(null);
  };

  const handlePickLocalDir = async () => {
    if (!window.fsApi) return;
    const root = await window.fsApi.addRoot();
    if (root) setPickedRoot(root);
  };

  const handleConfirmCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      setBusy(true);
      setError(null);
      const folder = await createFolder.mutateAsync({
        name: trimmed,
        localDir: pickedRoot?.name ?? null,
      });
      pickFolder(folder.id);
      resetCreateState();
    } catch {
      setError("创建项目失败");
    } finally {
      setBusy(false);
    }
  };

  const handleCreateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && newName.trim()) {
      e.preventDefault();
      void handleConfirmCreate();
    } else if (e.key === "Escape") {
      resetCreateState();
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      setError(null);
      resetCreateState();
    }
  };

  const panel = (
    <PickerPanel
      query={query}
      onQueryChange={setQuery}
      noneSelected={!selectedFolder && !pendingCloud}
      onPickNone={pickNone}
      isSearching={isSearching}
      pinnedFolders={pinnedFolders}
      recentFolders={recentFolders}
      searchResults={searchResults}
      pinnedFolderIds={pinnedFolderIds}
      selectedFolderId={selectedFolder?.id ?? null}
      onPickFolder={pickFolder}
      onTogglePin={togglePin}
      pendingCloud={pendingCloud}
      onPickCloud={pickCloud}
      onOpenLocalFolder={() => void openLocalFolder()}
      busy={busy}
      error={error}
      creating={creating}
      newName={newName}
      onNewNameChange={setNewName}
      onStartCreate={() => {
        setCreating(true);
        setNewName("");
        setPickedRoot(null);
      }}
      onConfirmCreate={() => void handleConfirmCreate()}
      onCancelCreate={resetCreateState}
      onPickLocalDir={() => void handlePickLocalDir()}
      pickedRoot={pickedRoot}
      onCreateKeyDown={handleCreateKeyDown}
      onCreateFromSearch={() => {
        setCreating(true);
        setNewName(query.trim());
        setPickedRoot(null);
      }}
    />
  );

  if (!hasSelection) {
    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            aria-label="归入项目"
            className="h-8 px-2 text-xs font-medium text-muted-foreground"
          >
            归入项目…
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          {panel}
        </PopoverContent>
      </Popover>
    );
  }

  const chipIcon = selectedFolder ? (
    <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
  ) : (
    <Cloud size={14} className="shrink-0 text-muted-foreground" />
  );

  const chipLabel = selectedFolder ? selectedFolder.name : "云端";
  const chipTitle = selectedFolder
    ? `归入：${selectedFolder.name}`
    : "仅云端存储";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <div className="flex max-w-[200px] items-center gap-0.5">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            aria-label="更改对话归属"
            title={chipTitle}
            className="h-auto min-w-0 flex-1 justify-start gap-1.5 px-2 py-1 font-medium text-muted-foreground"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {chipIcon}
              <span className="min-w-0 truncate">{chipLabel}</span>
              <ChevronDown
                size={12}
                className="shrink-0 text-muted-foreground"
              />
            </span>
          </Button>
        </PopoverTrigger>
        <IconButton
          size="md"
          aria-label="清除归入"
          title="清除归入"
          onClick={clearSelection}
          className="shrink-0 text-muted-foreground"
        >
          <X size={14} />
        </IconButton>
      </div>
      <PopoverContent align="start" className="w-72 p-0">
        {panel}
      </PopoverContent>
    </Popover>
  );
}

function PickerPanel({
  query,
  onQueryChange,
  noneSelected,
  onPickNone,
  isSearching,
  pinnedFolders,
  recentFolders,
  searchResults,
  pinnedFolderIds,
  selectedFolderId,
  onPickFolder,
  onTogglePin,
  pendingCloud,
  onPickCloud,
  onOpenLocalFolder,
  busy,
  error,
  creating,
  newName,
  onNewNameChange,
  onStartCreate,
  onConfirmCreate,
  onCancelCreate,
  onPickLocalDir,
  pickedRoot,
  onCreateKeyDown,
  onCreateFromSearch,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  noneSelected: boolean;
  onPickNone: () => void;
  isSearching: boolean;
  pinnedFolders: FolderMeta[];
  recentFolders: FolderMeta[];
  searchResults: FolderMeta[];
  pinnedFolderIds: string[];
  selectedFolderId: string | null;
  onPickFolder: (id: string) => void;
  onTogglePin: (id: string) => void;
  pendingCloud: boolean;
  onPickCloud: () => void;
  onOpenLocalFolder: () => void;
  busy: boolean;
  error: string | null;
  creating: boolean;
  newName: string;
  onNewNameChange: (n: string) => void;
  onStartCreate: () => void;
  onConfirmCreate: () => void;
  onCancelCreate: () => void;
  onPickLocalDir: () => void;
  pickedRoot: { id: string; name: string } | null;
  onCreateKeyDown: (e: React.KeyboardEvent) => void;
  onCreateFromSearch: () => void;
}) {
  const idleHint = isDesktop
    ? "不选则先聊；需要写文件时在本机自动建项目"
    : "不选则先聊；需要时在云端建项目";

  const noSearchHits = isSearching && searchResults.length === 0;

  const renderFolderRow = (f: FolderMeta) => (
    <PickerRow
      key={f.id}
      icon={<FolderOpen size={14} />}
      label={f.name}
      selected={selectedFolderId === f.id}
      onClick={() => onPickFolder(f.id)}
      isPinned={pinnedFolderIds.includes(f.id)}
      onTogglePin={() => onTogglePin(f.id)}
    />
  );

  return (
    <>
      <div className="border-b border-border px-3 py-2.5">
        <div className="text-xs font-medium text-foreground">对话归属</div>
        <div className="text-xs text-muted-foreground">{idleHint}</div>
      </div>

      <div className="max-h-[360px] overflow-y-auto p-1.5">
        <PickerRow
          icon={<MessageSquarePlus size={14} />}
          label="不归入项目"
          hint="先聊到再说"
          selected={noneSelected}
          onClick={onPickNone}
        />

        <div className="mx-2.5 mt-2 mb-1">
          <SearchField
            value={query}
            onValueChange={onQueryChange}
            placeholder="筛选项目…"
            aria-label="筛选项目"
            inputClassName="text-xs"
          />
        </div>

        {creating ? (
          <div className="px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              <FolderPlus size={14} className="shrink-0 text-muted-foreground" />
              <input
                value={newName}
                onChange={(e) => onNewNameChange(e.target.value)}
                onKeyDown={onCreateKeyDown}
                placeholder="项目名称"
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus
              />
            </div>
            {isDesktop && (
              <button
                type="button"
                onClick={onPickLocalDir}
                className="mt-1.5 ml-5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <FolderOpen size={12} />
                {pickedRoot ? pickedRoot.name : "绑定本地文件夹（可选）"}
              </button>
            )}
            <div className="mt-1.5 ml-5 flex gap-1.5">
              <Button
                variant="primary"
                size="sm"
                className="h-6 text-xs"
                onClick={onConfirmCreate}
                disabled={!newName.trim() || busy}
              >
                创建
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={onCancelCreate}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <PickerRow
            icon={<FolderPlus size={14} />}
            label="新建项目…"
            onClick={onStartCreate}
          />
        )}

        {isSearching ? (
          <>
            {searchResults.map(renderFolderRow)}
            {noSearchHits && (
              <div className="px-2.5 py-2">
                <p className="text-xs text-muted-foreground">没有匹配的项目</p>
                <Button
                  variant="ghost"
                  className="mt-1 h-auto w-full justify-start gap-2 px-0 py-1 text-xs text-primary"
                  onClick={onCreateFromSearch}
                >
                  <FolderPlus size={14} />
                  创建「{query.trim()}」项目
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            {pinnedFolders.length > 0 && (
              <>
                <div className="px-2.5 pt-1 pb-1 text-xs text-muted-foreground">
                  固定
                </div>
                {pinnedFolders.map(renderFolderRow)}
              </>
            )}
            {recentFolders.length > 0 && (
              <>
                <div className="px-2.5 pt-1 pb-1 text-xs text-muted-foreground">
                  最近项目
                </div>
                {recentFolders.map(renderFolderRow)}
              </>
            )}
          </>
        )}

        {isDesktop ? (
          <>
            <div className="my-1 border-t border-border" />
            <PickerRow
              icon={<HardDrive size={14} />}
              label="默认本地"
              hint="桌面端首发后在本机容器根下建对话空间"
              onClick={onOpenLocalFolder}
              disabled={busy}
            />
            <PickerRow
              icon={<Cloud size={14} />}
              label="仅云端（随手聊）"
              hint="文件只存云端，不创建本地项目"
              selected={pendingCloud}
              onClick={onPickCloud}
            />
          </>
        ) : (
          <>
            <div className="my-1 border-t border-border" />
            <PickerRow
              icon={<Cloud size={14} />}
              label="仅云端（随手聊）"
              hint="文件只存云端"
              selected={pendingCloud}
              onClick={onPickCloud}
            />
          </>
        )}

        {busy && (
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            处理中…
          </div>
        )}
        {error && (
          <p className="px-2.5 py-1.5 text-xs text-destructive">{error}</p>
        )}
      </div>
    </>
  );
}

function PickerRow({
  icon,
  label,
  hint,
  selected,
  onClick,
  disabled,
  isPinned,
  onTogglePin,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  selected?: boolean;
  onClick: () => void;
  disabled?: boolean;
  isPinned?: boolean;
  onTogglePin?: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: pin toggle is a real <button> inside; outer must not be <button>.
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onClick}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      className={`group/row flex h-auto w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium hover:bg-accent ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && (
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
      {onTogglePin && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          className="shrink-0 opacity-0 transition-opacity group-hover/row:opacity-100 text-muted-foreground hover:text-foreground"
          title={isPinned ? "取消固定" : "固定"}
        >
          {isPinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>
      )}
      {selected && <Check size={14} className="shrink-0 text-primary" />}
    </div>
  );
}
