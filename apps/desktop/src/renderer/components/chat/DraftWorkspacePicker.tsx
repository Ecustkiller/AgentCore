import { Button, IconButton } from "@/components/ui";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useGroupedConversations } from "@/hooks/useConversations";
import { hasLocalFiles } from "@/lib/capabilities";
import { ensureDefaultContainerRoot } from "@/services/defaultWorkspace";
import {
  Check,
  ChevronDown,
  Cloud,
  FolderOpen,
  HardDrive,
  Loader2,
  MessageSquarePlus,
  Search,
  X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { FolderMeta } from "@/services/folders";
import { useFoldersStore } from "@/stores/folders";

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

  const grouped = useGroupedConversations().data;
  const folders = useMemo(() => grouped?.folders ?? [], [grouped]);
  const conversations = useMemo(() => grouped?.conversations ?? [], [grouped]);

  const pendingFolderId = useFoldersStore((s) => s.pendingNewChatFolderId);
  const pendingCloud = useFoldersStore((s) => s.pendingNewChatCloud);
  const setFolder = useFoldersStore((s) => s.setPendingNewChatFolder);
  const setCloud = useFoldersStore((s) => s.setPendingNewChatCloud);

  const lastActivity = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of conversations) {
      if (!c.folderId) continue;
      const t = Date.parse(c.updatedAt) || 0;
      map.set(c.folderId, Math.max(map.get(c.folderId) ?? 0, t));
    }
    return map;
  }, [conversations]);

  const recentFolders = useMemo(
    () =>
      [...folders]
        .sort(
          (a, b) =>
            (lastActivity.get(b.id) ?? 0) - (lastActivity.get(a.id) ?? 0),
        )
        .slice(0, RECENT_WHEN_IDLE),
    [folders, lastActivity],
  );

  const listedFolders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recentFolders;
    return [...folders]
      .filter((f) => f.name.toLowerCase().includes(q))
      .sort(
        (a, b) => (lastActivity.get(b.id) ?? 0) - (lastActivity.get(a.id) ?? 0),
      )
      .slice(0, SEARCH_RESULT_CAP);
  }, [query, folders, recentFolders, lastActivity]);

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

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      setError(null);
    }
  };

  const panel = (
    <PickerPanel
      query={query}
      onQueryChange={setQuery}
      noneSelected={!selectedFolder && !pendingCloud}
      onPickNone={pickNone}
      listedFolders={listedFolders}
      selectedFolderId={selectedFolder?.id ?? null}
      onPickFolder={pickFolder}
      pendingCloud={pendingCloud}
      onPickCloud={pickCloud}
      onOpenLocalFolder={() => void openLocalFolder()}
      busy={busy}
      error={error}
      showRecentLabel={!query.trim() && recentFolders.length > 0}
      noSearchHits={
        !!query.trim() &&
        listedFolders.length === 0 &&
        folders.length > 0
      }
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
  listedFolders,
  selectedFolderId,
  onPickFolder,
  pendingCloud,
  onPickCloud,
  onOpenLocalFolder,
  busy,
  error,
  showRecentLabel,
  noSearchHits,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  noneSelected: boolean;
  onPickNone: () => void;
  listedFolders: FolderMeta[];
  selectedFolderId: string | null;
  onPickFolder: (id: string) => void;
  pendingCloud: boolean;
  onPickCloud: () => void;
  onOpenLocalFolder: () => void;
  busy: boolean;
  error: string | null;
  showRecentLabel: boolean;
  noSearchHits: boolean;
}) {
  const idleHint = isDesktop
    ? "不选则先聊；需要写文件时在本机自动建项目"
    : "不选则先聊；需要时在云端建项目";

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

        <div className="relative mx-2.5 mt-2 mb-1">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="搜索项目…"
            className="h-8 pl-8 text-xs"
            aria-label="搜索项目"
          />
        </div>

        {showRecentLabel && (
          <div className="px-2.5 pt-1 pb-1 text-xs text-muted-foreground">
            最近项目
          </div>
        )}

        {listedFolders.map((f) => (
          <PickerRow
            key={f.id}
            icon={<FolderOpen size={14} />}
            label={f.name}
            selected={selectedFolderId === f.id}
            onClick={() => onPickFolder(f.id)}
          />
        ))}

        {noSearchHits && (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">
            没有匹配的项目
          </p>
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
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  selected?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      className="h-auto w-full justify-start gap-2 rounded-lg px-2.5 py-1.5 text-left font-medium disabled:opacity-50"
    >
      <span className="flex w-full items-center gap-2">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {hint && (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {hint}
            </span>
          )}
        </span>
        {selected && <Check size={14} className="shrink-0 text-primary" />}
      </span>
    </Button>
  );
}
