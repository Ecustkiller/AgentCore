import { CreateFolderCascadePanel } from "@/components/folders/CreateFolderMenu";
import { Button, SearchField } from "@/components/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  WorkspaceModeMenu,
  WorkspaceModeTrigger,
  useWorkspaceModeState,
} from "@/components/workspace/WorkspaceModeControl";
import { useGroupedConversations } from "@/hooks/useConversations";
import { hasLocalFiles } from "@/lib/capabilities";
import {
  getComposerChannelPreference,
  setComposerChannelPreference,
} from "@/lib/composerChannelPreference";
import { visibleDraftProjects } from "@/lib/draftWorkspaceProjects";
import { pickAndOpenLocalProject } from "@/lib/openLocalProject";
import { formatWorkspaceChipTitle } from "@/lib/workspaceEffectiveMode";
import {
  type FolderMeta,
  dedupeFoldersByLocalBinding,
} from "@/services/folders";
import { type DraftWorkspaceIntent, useFoldersStore } from "@/stores/folders";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Cloud,
  FolderOpen,
  GitBranch,
  HardDrive,
  Loader2,
  Plus,
  Upload,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { WorkspaceChannelGuideDialog } from "./WorkspaceChannelGuideDialog";

/**
 * Always-on「在哪工作」chip for the TurnComposer 底栏左簇（工作区首位）。
 * Draft: 云入口 + 本机传统（桌面）+ 已有项目；禁本机草稿；记上次通道（无顶栏说明壳）。
 * Bound conversation: read-only status (+ backup when local legacy).
 */
export function ComposerWorkspaceChip({
  conversationId,
}: {
  conversationId: string | null;
}) {
  if (conversationId) {
    return <BoundChip conversationId={conversationId} />;
  }
  return <DraftChip />;
}

function BoundChip({ conversationId }: { conversationId: string }) {
  const state = useWorkspaceModeState(conversationId);
  const [pop, setPop] = useState(false);

  if (!state) {
    return (
      <span className="inline-flex h-7 items-center gap-1 px-1.5 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" />…
      </span>
    );
  }

  const boundTitle = formatWorkspaceChipTitle(state.effective);

  return (
    <div className="relative shrink-0">
      <Popover open={pop} onOpenChange={setPop}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={boundTitle}
            title={boundTitle}
            className="inline-flex h-8 max-w-[220px] items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            data-testid="composer-workspace-chip"
          >
            <WorkspaceModeTrigger
              effective={state.effective}
              className="text-xs"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <WorkspaceModeMenu
            state={state}
            conversationId={conversationId}
            onActionDone={() => setPop(false)}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function draftLabel(
  intent: DraftWorkspaceIntent,
  folders: FolderMeta[],
): { icon: "local" | "cloud" | "project"; text: string } {
  if (intent.kind === "quick_cloud") {
    return { icon: "cloud", text: "快速对话" };
  }
  // Legacy intent（入口已砍；发送时改导云，不再造本机草稿）
  if (intent.kind === "quick_local") {
    return { icon: "local", text: "本机草稿" };
  }
  const folder = folders.find((f) => f.id === intent.folderId);
  if (!folder) return { icon: "project", text: "项目" };
  return {
    icon: folder.mode === "local" ? "local" : "cloud",
    text: folder.name,
  };
}

function folderLocationHint(f: FolderMeta): string {
  if (f.mode === "cloud") return "云端空间";
  if (f.localSubpath) return `本地 · ${f.localSubpath}`;
  return "本机文件夹";
}

function DraftChip() {
  const navigate = useNavigate();
  const [pop, setPop] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  /** Same popover handoff — avoid close→open race that swallows CreateFolderMenu. */
  const [view, setView] = useState<"pick" | "create">("pick");
  const intent = useFoldersStore((s) => s.draftWorkspaceIntent);
  const setIntent = useFoldersStore((s) => s.setDraftWorkspaceIntent);
  const isDesktop = hasLocalFiles();
  const lastChannel = getComposerChannelPreference();

  const grouped = useGroupedConversations().data;
  const folders = useMemo(() => {
    const list = dedupeFoldersByLocalBinding(grouped?.folders ?? []);
    return isDesktop ? list : list.filter((f) => f.mode === "cloud");
  }, [grouped?.folders, isDesktop]);

  const selectedFolderId = intent.kind === "project" ? intent.folderId : null;

  const {
    visible: projectRows,
    matchCount,
    canExpand,
    hiddenCount,
  } = useMemo(
    () =>
      visibleDraftProjects({
        folders,
        conversations: grouped?.conversations ?? [],
        query,
        expanded: projectsExpanded,
        selectedFolderId,
      }),
    [
      folders,
      grouped?.conversations,
      query,
      projectsExpanded,
      selectedFolderId,
    ],
  );

  const { icon, text } = draftLabel(intent, folders);

  const resetPickChrome = () => {
    setQuery("");
    setProjectsExpanded(false);
    setView("pick");
  };

  const closePick = () => {
    setPop(false);
    resetPickChrome();
  };

  const pickQuickCloud = () => {
    setComposerChannelPreference("cloud");
    setIntent({ kind: "quick_cloud" });
    closePick();
  };

  const pickProject = (folder: FolderMeta) => {
    setComposerChannelPreference(
      folder.mode === "local" ? "local_traditional" : "cloud",
    );
    setIntent({ kind: "project", folderId: folder.id });
    closePick();
  };

  const connectGit = () => {
    setComposerChannelPreference("cloud");
    closePick();
    useFoldersStore.getState().openConnectGit();
  };

  const importToCloud = () => {
    setComposerChannelPreference("cloud");
    closePick();
    useFoldersStore.getState().openImportToCloud();
  };

  const pickLocalTraditional = () => {
    setComposerChannelPreference("local_traditional");
    closePick();
    void pickAndOpenLocalProject(navigate);
  };

  const openCreateCloud = () => {
    setComposerChannelPreference("cloud");
    setView("create");
  };

  const openGuide = () => {
    setPop(false);
    setGuideOpen(true);
  };

  return (
    <div className="relative shrink-0">
      <WorkspaceChannelGuideDialog
        open={guideOpen}
        onOpenChange={setGuideOpen}
        showLocalTraditional={isDesktop}
      />
      <Popover
        open={pop}
        onOpenChange={(o) => {
          setPop(o);
          if (!o) resetPickChrome();
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="在哪工作"
            title={text}
            className="inline-flex h-8 max-w-[200px] items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            {icon === "cloud" ? (
              <Cloud size={13} className="shrink-0" />
            ) : icon === "local" ? (
              <HardDrive size={13} className="shrink-0" />
            ) : (
              <FolderOpen size={13} className="shrink-0" />
            )}
            <span className="min-w-0 truncate">{text}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          // Keep side when switching pick→create (taller cascade); flip feels like a jump.
          avoidCollisions={false}
          className={view === "create" ? "w-auto p-0" : "w-72 p-0"}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {view === "create" ? (
            <div>
              <div className="flex items-center gap-1 border-b border-border px-1 py-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs font-normal text-muted-foreground"
                  onClick={() => setView("pick")}
                >
                  <ChevronLeft size={14} />
                  在哪工作
                </Button>
                <span className="px-1 text-xs font-medium text-foreground">
                  新建云项目
                </span>
              </div>
              <CreateFolderCascadePanel onClose={closePick} />
            </div>
          ) : (
            <div className="max-h-[360px] overflow-y-auto p-1.5">
              <DraftRow
                icon={<Cloud size={14} />}
                label="快速对话"
                selected={intent.kind === "quick_cloud"}
                onClick={pickQuickCloud}
              />
              <DraftRow
                icon={<Plus size={14} />}
                label="新建云项目"
                onClick={openCreateCloud}
              />
              {isDesktop ? (
                <>
                  <DraftRow
                    icon={<Upload size={14} />}
                    label="导入本机项目到云"
                    onClick={importToCloud}
                  />
                  <DraftRow
                    icon={<GitBranch size={14} />}
                    label="从 Git 克隆"
                    onClick={connectGit}
                  />
                  <DraftRow
                    icon={<HardDrive size={14} />}
                    label="打开本机项目"
                    badge={
                      lastChannel === "local_traditional" ? "上次" : undefined
                    }
                    onClick={pickLocalTraditional}
                  />
                </>
              ) : null}
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                onClick={openGuide}
              >
                了解区别
              </button>

              <div className="my-1 border-t border-border" />
              <div className="mx-2.5 mb-1 flex items-center gap-2 pt-1">
                <span className="shrink-0 text-xs text-muted-foreground">
                  项目
                </span>
                <SearchField
                  value={query}
                  onValueChange={setQuery}
                  placeholder="筛选…"
                  aria-label="筛选项目"
                  className="min-w-0 flex-1"
                  inputClassName="text-xs"
                />
              </div>
              {projectRows.map((f) => (
                <DraftRow
                  key={f.id}
                  icon={<FolderOpen size={14} />}
                  label={f.name}
                  hint={folderLocationHint(f)}
                  selected={
                    intent.kind === "project" && intent.folderId === f.id
                  }
                  onClick={() => pickProject(f)}
                />
              ))}
              {matchCount === 0 && (
                <p className="px-2.5 py-2 text-xs text-muted-foreground">
                  {query.trim() ? "没有匹配的项目" : "还没有项目"}
                </p>
              )}
              {canExpand && !projectsExpanded && hiddenCount > 0 ? (
                <DraftRow
                  icon={<ChevronDown size={14} />}
                  label={`查看全部（${matchCount}）`}
                  onClick={() => setProjectsExpanded(true)}
                />
              ) : null}
              {canExpand && projectsExpanded ? (
                <DraftRow
                  icon={<ChevronUp size={14} />}
                  label="收起"
                  onClick={() => setProjectsExpanded(false)}
                />
              ) : null}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function DraftRow({
  icon,
  label,
  hint,
  badge,
  selected,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  badge?: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="h-auto w-full justify-start gap-2 px-2.5 py-1.5 text-left text-xs font-medium"
      icon={<span className="shrink-0 text-muted-foreground">{icon}</span>}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{label}</span>
          {badge ? (
            <span className="shrink-0 rounded-lg bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              {badge}
            </span>
          ) : null}
        </span>
        {hint && (
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
      {selected && <Check size={14} className="shrink-0 text-primary" />}
    </Button>
  );
}
