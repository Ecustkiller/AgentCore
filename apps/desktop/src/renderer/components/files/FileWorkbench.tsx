import { FileDetail } from "@/components/files/FileDetail";
import { FileTree, type FileTreeHandle } from "@/components/files/FileTree";
import { EmptyHint, IconButton, InlineError } from "@/components/files/parts";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { FileSource } from "@/lib/fileSource";
import { cn } from "@/lib/utils";
import { createLocalRootSource } from "@/services/sources/localRootSource";
import { createCloudWorkspaceSource } from "@/services/sources/workspaceSource";
import type { WorkspaceInfo } from "@/services/workspaces";
import { useFoldersStore } from "@/stores/folders";
import {
  Cloud,
  FilePlus,
  FileText,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Loader2,
  MessageSquare,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

/** Build the {@link FileSource} for a workspace (cloud → REST, local → desktop IPC).
 * Local resolves only on desktop (needs `window.fsApi` + a bound root). A non-empty
 * `ws.subpath` (工作区对称化 D1a) scopes the local source to that subtree under the
 * shared container root. */
function workspaceSource(
  ws: WorkspaceInfo,
  fsAvailable: boolean,
): FileSource | null {
  if (ws.location === "local") {
    if (!fsAvailable || !ws.rootId) return null;
    return createLocalRootSource(ws.rootId, ws.name, ws.subpath);
  }
  return createCloudWorkspaceSource(ws.wsId, ws.name);
}

/** `ws_id = folder:<id>` → its folder id (lifecycle ops are folder ops). */
function folderIdOf(wsId: string): string | null {
  return wsId.startsWith("folder:") ? wsId.slice("folder:".length) : null;
}

const RAIL_KEY = "agentcore:files-rail-width";
const RAIL_MIN = 200;
const RAIL_MAX = 600;
const RAIL_DEFAULT = 288; // = Tailwind w-72，沿用旧固定宽度作默认

function clampRail(px: number): number {
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
}

function loadRailWidth(): number {
  try {
    const raw = localStorage.getItem(RAIL_KEY);
    if (!raw) return RAIL_DEFAULT;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? clampRail(n) : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
}

function saveRailWidth(px: number): void {
  try {
    localStorage.setItem(RAIL_KEY, String(px));
  } catch {
    /* unavailable — session-only */
  }
}

interface Tab {
  wsId: string;
  path: string;
  name: string;
}

/** Stable per-file key (a workspace's path is unique within it). */
function tabKey(wsId: string, path: string): string {
  return `${wsId}:${path}`;
}

/**
 * The cross-project 文件 hub's **split** file UI (VSCode 式左树右详情) — the merged
 * left rail stacks every workspace (= folder, cloud + local) as a **flat,
 * non-collapsible section** ({@link WorkspaceSection}): a header (name + cloud/local
 * badge + create buttons) over its always-shown file tree (其自带 {@link FileSource}).
 * 全部平铺、无「home / 其他项目」分区——只靠 cloud/local 徽标区分（用户 2026-06 决定）。
 * 工作区一视同仁（工作区对称化 D1a 起不再有置顶的「我的工作区」默认壳——裸聊产文件时由服务端
 * 懒建一个 per 对话本地工作区，与云端裸聊同构）。The right pane is a **tab strip** — opening
 * files stacks tabs, each {@link FileDetail} stays mounted (hidden when inactive) so
 * switching never drops editor / draft state. The tree always stays visible (unlike
 * the swap-style {@link FileBrowser} used in narrow side panels).
 *
 * Workspace lifecycle (rename / delete / new file·folder / view chats / upload)
 * lives on each root's **right-click menu** to keep the rail clean; page-level "new
 * folder / add local" sit in the rail header. Reuses {@link FileTree} in its
 * headerless `chrome={false}` form so per-source CRUD / drag / fold all come for free.
 *
 * No longer the lens onto a *single* project's home — that page (`/folders/:id`) is
 * gone (双模式工作区 决策 #9, 端态 I): this is purely the file lens, and chats live
 * on `/conversations`. The two cross-link: a root's「查看对话」jumps here→there, and
 * `/conversations`「浏览文件」jumps there→here (via `focusWsId`, which expands +
 * highlights the target root).
 */
export function FileWorkbench({
  workspaces,
  isLoading,
  isError,
  onRetry,
  fsAvailable,
  onNewFolder,
  onAddLocal,
  onRename,
  onDelete,
  onViewConversations,
  focusWsId,
  focusKey,
}: {
  workspaces: WorkspaceInfo[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  fsAvailable: boolean;
  onNewFolder: () => void;
  onAddLocal: () => void;
  onRename: (folderId: string, name: string) => void;
  onDelete: (folderId: string) => void;
  onViewConversations: (folderId: string) => void;
  /** When navigated here with a target workspace (`/conversations`「浏览文件」),
   * highlight + scroll to that section (全部恒展开，无需再展开)。`focusKey` (= navigation
   * key) makes re-focusing the same project on a later jump fire again. */
  focusWsId?: string | null;
  focusKey?: string;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [railWidth, setRailWidth] = useState<number>(() => loadRailWidth());
  // 从 /conversations「浏览文件」跳来时高亮的工作区根（1.5s 后消失，呼应对话页的 flash）。
  const [flashWsId, setFlashWsId] = useState<string | null>(null);
  const appliedFocusRef = useRef<string | null>(null);

  // 拖拽分隔条调左栏宽度：拖动期用窗口级监听 + 锁 body 光标/选区（避免拖过右侧编辑器时选中文本），
  // 松手落盘最终宽度（持久化，下次进页面沿用）。
  const startRailDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = railWidth;
    let latest = startW;
    const onMove = (ev: PointerEvent) => {
      latest = clampRail(startW + (ev.clientX - startX));
      setRailWidth(latest);
    };
    const onUp = () => {
      saveRailWidth(latest);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const nudgeRail = (delta: number) => {
    setRailWidth((w) => {
      const next = clampRail(w + delta);
      saveRailWidth(next);
      return next;
    });
  };

  // 工作区被删/消失 → 关掉它名下的标签页，并修正激活项。
  useEffect(() => {
    const live = tabs.filter((t) => workspaces.some((w) => w.wsId === t.wsId));
    if (live.length === tabs.length) return;
    setTabs(live);
    if (activeKey && !live.some((t) => tabKey(t.wsId, t.path) === activeKey)) {
      setActiveKey(live.length ? tabKey(live[0].wsId, live[0].path) : null);
    }
  }, [workspaces, tabs, activeKey]);

  // 从 /conversations「浏览文件」跳来：高亮 + 滚入目标工作区（全部恒展开，无需再展开一层）。
  // 每个 focusKey（导航键）只应用一次，但等到工作区列表就绪后才生效（冷进入 /files 时列表可能尚未加载）。
  useEffect(() => {
    if (!focusWsId || !focusKey) return;
    if (appliedFocusRef.current === focusKey) return;
    if (!workspaces.some((w) => w.wsId === focusWsId)) return;
    appliedFocusRef.current = focusKey;
    setFlashWsId(focusWsId);
    const t = setTimeout(() => setFlashWsId(null), 1500);
    return () => clearTimeout(t);
  }, [focusWsId, focusKey, workspaces]);

  // 每个工作区一个稳定的 FileSource（树与详情共用，按 ws 复用，避免重复构建/反复重载）。
  const sourceByWs = useMemo(() => {
    const m = new Map<string, FileSource | null>();
    for (const w of workspaces) m.set(w.wsId, workspaceSource(w, fsAvailable));
    return m;
  }, [workspaces, fsAvailable]);

  const activeTab = useMemo(
    () => tabs.find((t) => tabKey(t.wsId, t.path) === activeKey) ?? null,
    [tabs, activeKey],
  );

  // 打开文件：已开则激活其标签，未开则新增并激活（标签持久，直到手动关闭）。
  const openFile = (wsId: string, path: string, name: string) => {
    const key = tabKey(wsId, path);
    setTabs((prev) =>
      prev.some((t) => tabKey(t.wsId, t.path) === key)
        ? prev
        : [...prev, { wsId, path, name }],
    );
    setActiveKey(key);
  };

  // 关标签：关的是激活页则跳到相邻页（优先右、否则左），全关则回空态。
  const closeTab = (key: string) => {
    const idx = tabs.findIndex((t) => tabKey(t.wsId, t.path) === key);
    if (idx === -1) return;
    const next = tabs.filter((_, i) => i !== idx);
    setTabs(next);
    if (activeKey === key) {
      const ni = Math.min(idx, next.length - 1);
      setActiveKey(ni >= 0 ? tabKey(next[ni].wsId, next[ni].path) : null);
    }
  };

  // 只留这一页（其余全关），并将其设为激活。
  const closeOthers = (key: string) => {
    const keep = tabs.find((t) => tabKey(t.wsId, t.path) === key);
    if (!keep) return;
    setTabs([keep]);
    setActiveKey(key);
  };

  const closeAll = () => {
    setTabs([]);
    setActiveKey(null);
  };

  return (
    <div className="flex h-full w-full">
      {/* Left: workspaces + their files as one multi-root tree (resizable). */}
      <aside
        style={{ width: railWidth }}
        className="flex shrink-0 flex-col border-r border-border"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="text-base font-medium text-foreground">文件</span>
          <div className="flex items-center">
            {fsAvailable && (
              <IconButton title="添加本地文件夹" onClick={onAddLocal}>
                <HardDrive size={16} />
              </IconButton>
            )}
            <IconButton title="新建文件夹" onClick={onNewFolder}>
              <FolderPlus size={16} />
            </IconButton>
          </div>
        </div>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2
              size={18}
              className="animate-spin text-muted-foreground/50"
            />
          </div>
        ) : isError ? (
          <InlineError onRetry={onRetry} />
        ) : workspaces.length === 0 ? (
          <EmptyHint
            icon={<FolderOpen size={24} className="text-muted-foreground/40" />}
            title="还没有项目工作区"
            hint={
              fsAvailable
                ? "点右上「新建文件夹」建云端项目，或「添加本地文件夹」绑定本机目录。"
                : "点右上「新建文件夹」建一个云端项目；在对话里产生文件也会自动建工作区。"
            }
          />
        ) : (
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-1">
            {workspaces.map((ws) => (
              <WorkspaceSection
                key={ws.wsId}
                ws={ws}
                source={sourceByWs.get(ws.wsId) ?? null}
                activePath={activeTab?.wsId === ws.wsId ? activeTab.path : null}
                onOpenFile={(path, name) => openFile(ws.wsId, path, name)}
                onRename={onRename}
                onDelete={onDelete}
                onViewConversations={onViewConversations}
                flashing={ws.wsId === flashWsId}
              />
            ))}
          </div>
        )}
      </aside>

      {/* Draggable sash between tree and detail (keyboard: ←/→ to nudge). */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整文件树宽度"
        tabIndex={0}
        onPointerDown={startRailDrag}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            nudgeRail(-16);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            nudgeRail(16);
          }
        }}
        style={{ touchAction: "none" }}
        className="z-10 w-1.5 shrink-0 cursor-col-resize transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none"
      />

      {/* Right: open files as tabs; every open file stays mounted (hidden when
          inactive) so switching never unmounts an editor or drops unsaved /
          transient state. */}
      <section className="flex min-w-0 flex-1 flex-col">
        {tabs.length === 0 ? (
          <EmptyHint
            inline
            icon={<FileText size={26} className="text-muted-foreground/40" />}
            title="选择一个文件"
            hint="从左侧的项目树里点开文件，可同时打开多个、用标签页来回切换。"
          />
        ) : (
          <>
            <DetailTabs
              tabs={tabs}
              activeKey={activeKey}
              onActivate={setActiveKey}
              onClose={closeTab}
              onCloseOthers={closeOthers}
              onCloseAll={closeAll}
            />
            <div className="relative min-h-0 flex-1">
              {tabs.map((t) => {
                const key = tabKey(t.wsId, t.path);
                const src = sourceByWs.get(t.wsId) ?? null;
                return (
                  <div
                    key={key}
                    className={cn(
                      "absolute inset-0",
                      key === activeKey ? "" : "hidden",
                    )}
                  >
                    {src ? (
                      <FileDetail
                        source={src}
                        path={t.path}
                        name={t.name}
                        onClose={() => closeTab(key)}
                      />
                    ) : (
                      <EmptyHint
                        inline
                        icon={
                          <FileText
                            size={26}
                            className="text-muted-foreground/40"
                          />
                        }
                        title="无法打开此文件"
                        hint="它所属项目的文件源暂不可用。"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * One workspace = a **flat, non-collapsible section**: a header (name + cloud/local
 * badge + create buttons) with its file tree always shown beneath. 全部平铺、去掉
 * 「home / 其他项目」分区——工作区之间只靠 cloud/local 徽标区分（用户 2026-06 决定），且
 * 一视同仁（工作区对称化 D1a 起无置顶的默认壳，每个工作区都可重命名 / 删除 / 查看对话）。
 * Lifecycle (重命名 / 删除 / 查看对话) lives on the right-click menu; 新建 / 上传 are
 * header buttons + menu items. Tree 恒挂载，故新建直接走 {@link FileTreeHandle}、无需先
 * 展开；一个刚建出的文件夹经共享 `pendingRename` store 直接进内联改名。空态对懒建的本地
 * 工作区（有 `subpath`）用「AI 产物落点」文案，其余用「空文件夹」。
 */
function WorkspaceSection({
  ws,
  source,
  activePath,
  onOpenFile,
  onRename,
  onDelete,
  onViewConversations,
  flashing,
}: {
  ws: WorkspaceInfo;
  source: FileSource | null;
  activePath: string | null;
  onOpenFile: (path: string, name: string) => void;
  onRename: (folderId: string, name: string) => void;
  onDelete: (folderId: string) => void;
  onViewConversations: (folderId: string) => void;
  flashing: boolean;
}) {
  const folderId = folderIdOf(ws.wsId);
  const isLocal = ws.location === "local";
  const localUnavailable = isLocal && !source;

  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<FileTreeHandle>(null);

  // 被聚焦（从对话页「浏览文件」跳来）时滚入可视区。
  useEffect(() => {
    if (flashing) rootRef.current?.scrollIntoView({ block: "nearest" });
  }, [flashing]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ws.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);

  const pendingRenameId = useFoldersStore((s) => s.pendingRenameId);
  const setPendingRename = useFoldersStore((s) => s.setPendingRename);

  // 刚经「新建文件夹」建出的工作区：直接进入内联重命名。
  useEffect(() => {
    if (folderId && pendingRenameId === folderId) {
      setDraft(ws.name);
      setEditing(true);
      setPendingRename(null);
    }
  }, [pendingRenameId, folderId, ws.name, setPendingRename]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRename = () => {
    setEditing(false);
    const name = draft.trim();
    if (!folderId || !name || name === ws.name) return;
    onRename(folderId, name);
  };

  const handleDelete = () => {
    if (!folderId) return;
    if (
      !window.confirm(
        `确定删除项目「${ws.name}」？其下对话会保留并移入「未分组」。`,
      )
    ) {
      return;
    }
    onDelete(folderId);
  };

  if (editing) {
    return (
      <div>
        <div className="flex items-center gap-1.5 rounded-md bg-accent px-2 py-1.5">
          <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
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
            className="h-6 min-w-0 flex-1 bg-transparent text-sm text-accent-foreground focus:outline-none"
          />
        </div>
      </div>
    );
  }

  // 平铺标题行（不可折叠）：名字 + 新建按钮（hover 显形）+ 云端/本地徽标。
  const header = (
    <div
      className={cn(
        "group flex items-center rounded-md pr-1 text-sm",
        flashing && "ring-2 ring-inset ring-primary",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2">
        <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{ws.name}</span>
      </div>
      {source && (
        <div className="hidden shrink-0 items-center group-hover:flex">
          <IconButton
            title="新建文件"
            onClick={() => treeRef.current?.startCreate("file")}
          >
            <FilePlus size={14} />
          </IconButton>
          <IconButton
            title="新建文件夹"
            onClick={() => treeRef.current?.startCreate("dir")}
          >
            <FolderPlus size={14} />
          </IconButton>
        </div>
      )}
      <span
        className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs ${
          isLocal
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {isLocal ? <HardDrive size={12} /> : <Cloud size={12} />}
        {isLocal ? "本地" : "云端"}
      </span>
    </div>
  );

  const tree = localUnavailable ? (
    <div className="py-1 pl-7 text-xs text-muted-foreground/70">
      本地项目的文件在你电脑上，请在桌面端查看。
    </div>
  ) : source ? (
    <FileTree
      ref={treeRef}
      source={source}
      chrome={false}
      indent={14}
      activePath={activePath}
      onOpenFile={onOpenFile}
      emptyText={
        ws.subpath ? "还没有文件——对话里 AI 产出的文件会落在这里" : "空文件夹"
      }
    />
  ) : (
    <div className="py-1 pl-7 text-xs text-muted-foreground/70">
      无法打开此项目，文件源暂不可用。
    </div>
  );

  return (
    <div ref={rootRef}>
      <ContextMenu>
        <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          {!localUnavailable && source && (
            <>
              <ContextMenuItem
                onSelect={() => treeRef.current?.startCreate("file")}
              >
                <FilePlus size={14} className="shrink-0" />
                <span className="flex-1 truncate">新建文件</span>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => treeRef.current?.startCreate("dir")}
              >
                <FolderPlus size={14} className="shrink-0" />
                <span className="flex-1 truncate">新建文件夹</span>
              </ContextMenuItem>
              {source.caps.transfer && (
                <ContextMenuItem
                  onSelect={() => treeRef.current?.triggerUpload()}
                >
                  <Upload size={14} className="shrink-0" />
                  <span className="flex-1 truncate">上传到此项目</span>
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            onSelect={() => {
              setDraft(ws.name);
              setEditing(true);
            }}
          >
            <Pencil size={14} className="shrink-0" />
            <span className="flex-1 truncate">重命名</span>
          </ContextMenuItem>
          {folderId && (
            <ContextMenuItem onSelect={() => onViewConversations(folderId)}>
              <MessageSquare size={14} className="shrink-0" />
              <span className="flex-1 truncate">查看对话</span>
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem variant="danger" onSelect={handleDelete}>
            <Trash2 size={14} className="shrink-0" />
            <span className="flex-1 truncate">删除（对话保留）</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {tree}
    </div>
  );
}

/**
 * Horizontal tab strip for the detail pane. Pointer-down (not click) activates so
 * a tab switches even when the close button steals the click; middle-click closes
 * (browser-tab convention). Right-click opens 关闭 / 关闭其他 / 关闭全部. Overflows
 * scroll horizontally rather than wrapping.
 */
function DetailTabs({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
}: {
  tabs: Tab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onCloseOthers: (key: string) => void;
  onCloseAll: () => void;
}) {
  return (
    <div className="flex shrink-0 items-stretch overflow-x-auto border-b">
      {tabs.map((t) => {
        const key = tabKey(t.wsId, t.path);
        const active = key === activeKey;
        return (
          <ContextMenu key={key}>
            <ContextMenuTrigger asChild>
              <div
                role="tab"
                aria-selected={active}
                tabIndex={0}
                title={t.path}
                onPointerDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onClose(key);
                  } else if (e.button === 0) {
                    onActivate(key);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onActivate(key);
                  } else if (e.key === "Delete" || e.key === "Backspace") {
                    e.preventDefault();
                    onClose(key);
                  }
                }}
                className={cn(
                  "group flex min-w-0 max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 border-r px-3 py-1.5 text-sm",
                  active
                    ? "bg-background text-foreground"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted",
                )}
              >
                <FileText size={13} className="shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <button
                  type="button"
                  aria-label={`关闭 ${t.name}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(key);
                  }}
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded p-0.5 hover:bg-foreground/10",
                    active ? "opacity-70" : "opacity-0 group-hover:opacity-70",
                  )}
                >
                  <X size={13} />
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-40">
              <ContextMenuItem onSelect={() => onClose(key)}>
                <X size={14} className="shrink-0" />
                <span className="flex-1 truncate">关闭</span>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={tabs.length <= 1}
                onSelect={() => onCloseOthers(key)}
              >
                <span className="flex-1 truncate">关闭其他</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={onCloseAll}>
                <span className="flex-1 truncate">关闭全部</span>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}
