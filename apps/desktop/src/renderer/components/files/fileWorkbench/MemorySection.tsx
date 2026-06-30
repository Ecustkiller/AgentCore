import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { notifyActionError, notifySuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { listMemoryTopics, writeMemoryTopic } from "@/services/memory";
import {
  GLOBAL_PREFERENCES_PATH,
  GLOBAL_PROFILE_PATH,
  memoryProjectProfilePath,
  memoryTopicPath,
} from "@/services/sources/memorySource";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  SlidersHorizontal,
  Trash2,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import {
  loadMemoryCollapsed,
  loadMemoryTopicsExpanded,
  saveMemoryCollapsed,
  saveMemoryTopicsExpanded,
} from "./storage";

/** Which memory layer a section renders: the user's GLOBAL core, or one project's. */
export type MemoryScope =
  | { kind: "global" }
  | { kind: "project"; folderId: string; projectName: string };

/**
 * The folder-style「AI 记忆」rail section (Agent记忆与知识系统 §1.6) — a collapsible header over the
 * always-injected core leaves (偏好 global-only / 画像) **plus** a lazy 主题/ sub-folder of the
 * on-demand TOPIC notes (`consult_memory` pulls these; here they become browsable·editable·
 * deletable for the first time). Used twice: at the rail root for the GLOBAL layer
 * ({@link FileWorkbench}) and nested under a project ({@link WorkspaceSection}).
 *
 * Deliberately NOT the generic {@link FileTree}: memory is AI-maintained by fixed sections
 * (防漂移), so the rail offers only **打开 + (主题)删除** — no 新建 / 改名 / 移动 / 上传, which a
 * source-level cap can't express per-row (核心 偏好/画像 are never deletable, only 主题 are).
 * Opening any leaf reuses the shared editor host via the path-aware memory `FileSource`, so
 * full-text edit + preview + AI 改写 + CAS all come for free; 画像 routes to the 双栏 editor.
 */
export function MemorySection({
  scope,
  activePath,
  onOpen,
  onTopicDeleted,
  indent = 0,
}: {
  scope: MemoryScope;
  /** The synthetic path of the open memory tab (highlights the matching row), or null. */
  activePath: string | null;
  /** Open a memory leaf in the detail pane (synthetic leaf path + display name). */
  onOpen: (path: string, name: string) => void;
  /** A topic was deleted — let the host close its tab if it is open (its synthetic path). */
  onTopicDeleted: (path: string) => void;
  /** Base left indent (px): 0 at the rail root, > 0 when nested under a workspace section. */
  indent?: number;
}) {
  const folderId = scope.kind === "project" ? scope.folderId : null;
  const projectName = scope.kind === "project" ? scope.projectName : null;
  const scopeKey = folderId ?? "global";
  // Fold state persists per scope (记忆段默认展开、主题子夹默认折叠). The toggles read-modify-write
  // the shared localStorage set each time so sibling sections (other scopes) never clobber.
  const [sectionOpen, setSectionOpen] = useState(
    () => !loadMemoryCollapsed().has(scopeKey),
  );
  const [topicsOpen, setTopicsOpen] = useState(() =>
    loadMemoryTopicsExpanded().has(scopeKey),
  );
  const queryClient = useQueryClient();

  const toggleSection = () =>
    setSectionOpen((open) => {
      const next = !open;
      const set = loadMemoryCollapsed();
      if (next) set.delete(scopeKey);
      else set.add(scopeKey);
      saveMemoryCollapsed(set);
      return next;
    });

  const toggleTopics = () =>
    setTopicsOpen((open) => {
      const next = !open;
      const set = loadMemoryTopicsExpanded();
      if (next) set.add(scopeKey);
      else set.delete(scopeKey);
      saveMemoryTopicsExpanded(set);
      return next;
    });

  const topics = useQuery({
    queryKey: ["memory-topics", scopeKey],
    queryFn: () => listMemoryTopics(folderId),
    enabled: topicsOpen,
    staleTime: 30_000,
  });

  const profilePath = folderId
    ? memoryProjectProfilePath(folderId)
    : GLOBAL_PROFILE_PATH;
  const profileName = projectName ? `${projectName}·画像.md` : "画像.md";

  const headerPad = indent + 8;
  const leafPad = indent + 26;
  const topicPad = indent + 44;

  const deleteTopic = async (slug: string) => {
    if (!window.confirm(`确定删除记忆主题「${slug}」？此操作不可撤销。`))
      return;
    try {
      const r = await writeMemoryTopic(slug, "", null, folderId);
      if (!r.ok) throw new Error("写入冲突");
      onTopicDeleted(memoryTopicPath(folderId, slug));
      await queryClient.invalidateQueries({
        queryKey: ["memory-topics", scopeKey],
      });
      // A project's last memory note leaving may drop its「本项目记忆」rail node.
      if (folderId)
        await queryClient.invalidateQueries({ queryKey: ["memory-projects"] });
      notifySuccess("已删除记忆主题");
    } catch (e) {
      notifyActionError("删除失败", e);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={toggleSection}
        aria-expanded={sectionOpen}
        style={{ paddingLeft: headerPad }}
        className="flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent/60"
      >
        {sectionOpen ? (
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        )}
        <Brain size={14} className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">
          {scope.kind === "global" ? "AI 记忆 · 全局" : "本项目记忆"}
        </span>
      </button>

      {sectionOpen && (
        <>
          {scope.kind === "global" && (
            <MemoryLeafRow
              paddingLeft={leafPad}
              icon={
                <SlidersHorizontal
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
              }
              label="偏好"
              active={activePath === GLOBAL_PREFERENCES_PATH}
              onClick={() => onOpen(GLOBAL_PREFERENCES_PATH, "偏好.md")}
            />
          )}
          <MemoryLeafRow
            paddingLeft={leafPad}
            icon={
              <UserRound size={14} className="shrink-0 text-muted-foreground" />
            }
            label="画像"
            active={activePath === profilePath}
            onClick={() => onOpen(profilePath, profileName)}
          />

          <button
            type="button"
            onClick={toggleTopics}
            aria-expanded={topicsOpen}
            title="按需查阅的记忆主题（consult_memory 拉取）"
            style={{ paddingLeft: leafPad }}
            className="flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-sm text-foreground transition-colors hover:bg-accent/60"
          >
            {topicsOpen ? (
              <ChevronDown
                size={14}
                className="shrink-0 text-muted-foreground"
              />
            ) : (
              <ChevronRight
                size={14}
                className="shrink-0 text-muted-foreground"
              />
            )}
            {topicsOpen ? (
              <FolderOpen
                size={14}
                className="shrink-0 text-muted-foreground"
              />
            ) : (
              <Folder size={14} className="shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">主题</span>
          </button>

          {topicsOpen &&
            (topics.isLoading ? (
              <div
                className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground"
                style={{ paddingLeft: topicPad }}
              >
                <Loader2 size={12} className="animate-spin" />
                加载中…
              </div>
            ) : topics.isError ? (
              <button
                type="button"
                onClick={() => void topics.refetch()}
                style={{ paddingLeft: topicPad }}
                className="flex h-7 w-full items-center gap-1 text-left text-xs text-destructive/80 hover:underline"
              >
                加载失败，点此重试
              </button>
            ) : (topics.data ?? []).length === 0 ? (
              <div
                className="flex h-7 items-center text-xs text-muted-foreground/60"
                style={{ paddingLeft: topicPad }}
              >
                还没有主题记忆
              </div>
            ) : (
              (topics.data ?? []).map((slug) => {
                const path = memoryTopicPath(folderId, slug);
                return (
                  <ContextMenu key={slug}>
                    <ContextMenuTrigger asChild>
                      <MemoryLeafRow
                        paddingLeft={topicPad}
                        icon={
                          <FileText
                            size={14}
                            className="shrink-0 text-muted-foreground"
                          />
                        }
                        label={`${slug}.md`}
                        active={activePath === path}
                        onClick={() => onOpen(path, `${slug}.md`)}
                      />
                    </ContextMenuTrigger>
                    <ContextMenuContent className="min-w-36">
                      <ContextMenuItem
                        variant="danger"
                        onSelect={() => void deleteTopic(slug)}
                      >
                        <Trash2 size={14} className="shrink-0" />
                        <span className="flex-1 truncate">删除主题</span>
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })
            ))}
        </>
      )}
    </div>
  );
}

/** A single memory leaf row (偏好 / 画像 / 主题 note) — a slim button styled like the rail. */
function MemoryLeafRow({
  paddingLeft,
  icon,
  label,
  active,
  onClick,
}: {
  paddingLeft: number;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft }}
      className={cn(
        "flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-sm transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-foreground hover:bg-accent/60",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
