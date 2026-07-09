import { Button, IconButton, SearchField } from "@/components/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useGroupedConversations } from "@/hooks/useConversations";
import { hasLocalFiles } from "@/lib/capabilities";
import { ensureDefaultContainerRoot } from "@/services/defaultWorkspace";
import type { FolderMeta } from "@/services/folders";
import { useFoldersStore } from "@/stores/folders";
import {
  Check,
  ChevronDown,
  Cloud,
  FolderOpen,
  HardDrive,
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
 * B3+：存储（本地默认 / 仅云端）与归入项目（可选）分两区展示；只选已有项目，创建走命令面板
 * 「新建项目」。默认不选时工具栏只露「归入项目…」、不挂 chip（零门槛）。落点经 `pendingNewChat*`
 * 传给首发建会话；首发后锁定，改由 `WorkspaceModeBar` 承担。
 */
const breadcrumbTriggerClass =
  "inline-flex h-auto min-w-0 items-center gap-1 rounded-md px-1 py-0.5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground";

export function DraftWorkspacePicker({
  variant = "toolbar",
}: {
  /** `toolbar` = 新对话草稿区按钮样式；`breadcrumb` = 输入区上下文行内联样式（§十五）。 */
  variant?: "toolbar" | "breadcrumb";
}) {
  const isBreadcrumb = variant === "breadcrumb";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

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

  const pickLocal = () => {
    setCloud(false);
    if (isDesktop) void ensureDefaultContainerRoot();
  };

  const pickFolder = (id: string) => {
    setFolder(id);
    setCloud(false);
    setOpen(false);
  };

  const pickCloud = () => {
    setFolder(null);
    setCloud(true);
  };

  const clearFolder = () => {
    setFolder(null);
  };

  const clearSelection = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (selectedFolder) {
      clearFolder();
      return;
    }
    if (pendingCloud) {
      pickLocal();
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const panel = (
    <PickerPanel
      query={query}
      onQueryChange={setQuery}
      isSearching={isSearching}
      pinnedFolders={pinnedFolders}
      recentFolders={recentFolders}
      searchResults={searchResults}
      pinnedFolderIds={pinnedFolderIds}
      selectedFolderId={selectedFolder?.id ?? null}
      onPickFolder={pickFolder}
      onClearFolder={clearFolder}
      onTogglePin={togglePin}
      pendingCloud={pendingCloud}
      onPickLocal={pickLocal}
      onPickCloud={pickCloud}
    />
  );

  if (!hasSelection) {
    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          {isBreadcrumb ? (
            <button
              type="button"
              aria-label="归入项目"
              className={breadcrumbTriggerClass}
            >
              <FolderOpen size={14} className="shrink-0" />
              <span>归入项目…</span>
            </button>
          ) : (
            <Button
              variant="ghost"
              aria-label="归入项目"
              className="h-8 px-2 text-xs font-medium text-muted-foreground"
            >
              归入项目…
            </Button>
          )}
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
    ? `归入：${selectedFolder.name}（本地存储）`
    : "仅云端存储";
  const clearAriaLabel = selectedFolder ? "清除归入" : "改回本地默认";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <div
        className={
          isBreadcrumb
            ? "flex min-w-0 max-w-full items-center gap-0.5"
            : "flex max-w-[200px] items-center gap-0.5"
        }
      >
        <PopoverTrigger asChild>
          {isBreadcrumb ? (
            <button
              type="button"
              aria-label="更改对话归属"
              title={chipTitle}
              className={`${breadcrumbTriggerClass} min-w-0 flex-1`}
            >
              {chipIcon}
              <span className="min-w-0 truncate">{chipLabel}</span>
              <ChevronDown
                size={12}
                className="shrink-0 text-muted-foreground"
              />
            </button>
          ) : (
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
          )}
        </PopoverTrigger>
        <IconButton
          size="md"
          aria-label={clearAriaLabel}
          title={clearAriaLabel}
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

function SectionLabel({
  label,
  action,
}: {
  label: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-2.5 pt-2 pb-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {action}
    </div>
  );
}

function PickerPanel({
  query,
  onQueryChange,
  isSearching,
  pinnedFolders,
  recentFolders,
  searchResults,
  pinnedFolderIds,
  selectedFolderId,
  onPickFolder,
  onClearFolder,
  onTogglePin,
  pendingCloud,
  onPickLocal,
  onPickCloud,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  isSearching: boolean;
  pinnedFolders: FolderMeta[];
  recentFolders: FolderMeta[];
  searchResults: FolderMeta[];
  pinnedFolderIds: string[];
  selectedFolderId: string | null;
  onPickFolder: (id: string) => void;
  onClearFolder: () => void;
  onTogglePin: (id: string) => void;
  pendingCloud: boolean;
  onPickLocal: () => void;
  onPickCloud: () => void;
}) {
  const idleHint = isDesktop
    ? "默认本地存储，可随时归入项目"
    : "默认云端存储，可随时归入项目";

  const noSearchHits = isSearching && searchResults.length === 0;
  const noFoldersListed =
    !isSearching && pinnedFolders.length === 0 && recentFolders.length === 0;

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
        {isDesktop && (
          <>
            <SectionLabel label="存储位置" />
            <PickerRow
              icon={<HardDrive size={14} />}
              label="本地（默认）"
              hint="需要写文件时在本机容器根下建对话空间"
              selected={!pendingCloud}
              onClick={onPickLocal}
            />
            <PickerRow
              icon={<Cloud size={14} />}
              label="仅云端（随手聊）"
              hint="文件只存云端，不创建本地项目"
              selected={pendingCloud}
              onClick={onPickCloud}
            />
          </>
        )}

        <div className="my-1 border-t border-border" />
        <SectionLabel
          label="归入项目（可选）"
          action={
            selectedFolderId ? (
              <button
                type="button"
                onClick={onClearFolder}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                清除
              </button>
            ) : null
          }
        />

        <div className="mx-2.5 mb-1">
          <SearchField
            value={query}
            onValueChange={onQueryChange}
            placeholder="筛选项目…"
            aria-label="筛选项目"
            inputClassName="text-xs"
          />
        </div>

        {isSearching ? (
          <>
            {searchResults.map(renderFolderRow)}
            {noSearchHits && (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">
                没有匹配的项目
              </p>
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
            {noFoldersListed && (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">
                还没有项目——可在命令面板「新建项目」
              </p>
            )}
          </>
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
