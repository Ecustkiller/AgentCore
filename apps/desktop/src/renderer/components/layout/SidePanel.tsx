import { Markdown } from "@/components/chat/Markdown";
import { RunDetailBody } from "@/components/chat/detail/RunDetailBody";
import {
  CommandRegion,
  useCommandRegion,
} from "@/components/graph/CanvasDecisionPanel";
import { Button, IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { WorkspaceMode } from "@/components/workspace/WorkspacePanel";
import { useActiveMessageContent } from "@/stores/conversation";
import {
  type ExecutionRuntime,
  projectRuntime,
  useExecutionStore,
} from "@/stores/execution";
import {
  type DetailTab,
  WORKSPACE_TAB_ID,
  useSidePanelStore,
} from "@/stores/sidePanel";
import { FolderOpen, Sparkles, UserRound, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * A detail tab is live only while its message still holds an execution: any tab needs a
 * loaded plan; a run tab additionally needs its run to still exist in the PROJECTED
 * execution (§9.3 — 修订 vN revisions are born from frames, not `plan.runs`, so validate
 * against projected runs, not raw plan). Pure read used both to gate re-render and to
 * compute the visible set.
 */
function isDetailTabLive(
  byId: Record<string, ExecutionRuntime>,
  tab: DetailTab,
): boolean {
  const rt = byId[tab.messageId];
  if (!rt?.plan) return false;
  if (tab.kind !== "run") return true;
  return projectRuntime(rt)?.runs.some((r) => r.id === tab.runId) ?? false;
}

/**
 * The conversation's single right-docked surface (前端UX设计.md §十), modelled
 * as one flat tab strip: a fixed 「工作区」 home tab (files / snapshots /
 * handoff) followed by a closable run-detail tab per drilled-into graph node.
 * The workspace body is lazily mounted and then kept alive (hidden, not
 * unmounted) so its files aren't re-fetched when toggling between it and a run.
 */
export function SidePanel() {
  const open = useSidePanelStore((s) => s.open);
  const width = useSidePanelStore((s) => s.width);
  const setWidth = useSidePanelStore((s) => s.setWidth);
  const closePanel = useSidePanelStore((s) => s.closePanel);
  const tabs = useSidePanelStore((s) => s.tabs);
  const activeTabId = useSidePanelStore((s) => s.activeTabId);
  const setActiveTab = useSidePanelStore((s) => s.setActiveTab);
  const closeTab = useSidePanelStore((s) => s.closeTab);
  // 流式性能 (白屏卡死修复·Stage 3 收窄订阅): gate this dock on the SET of live tabs, not on
  // the whole `byId`. Subscribing to `byId` re-ran the panel (tab strip + RunDetailBody) on
  // every streaming token; RunDetailBody self-subscribes to its own slot, so the shell only
  // needs to know WHICH tabs stay valid — a key that changes only when that set does.
  const liveTabKey = useExecutionStore((s) =>
    tabs
      .filter((t) => isDetailTabLive(s.byId, t))
      .map((t) => t.id)
      .join("\u0001"),
  );
  // 图上指挥 (前端UX设计.md §6.2): the 指挥台 region pinned to the top of this one dock.
  // Called before the `open` early-return below so its auto-surface effect can reveal
  // the panel even while it's closed (a brand-new decision opens it). Inert in chat
  // mode (the bridge store's `active` is false there).
  const command = useCommandRegion();

  const visibleTabs = useMemo(() => {
    const live = new Set(liveTabKey ? liveTabKey.split("\u0001") : []);
    return tabs.filter((t) => live.has(t.id));
  }, [tabs, liveTabKey]);
  const activeTab =
    activeTabId === WORKSPACE_TAB_ID
      ? null
      : (visibleTabs.find((t) => t.id === activeTabId) ?? null);
  const workspaceActive = activeTabId === WORKSPACE_TAB_ID;

  // The content tab reads ONE message's text; subscribe to just that slice so a streaming
  // turn (a new `messages` array every tick) never re-renders this dock (收窄订阅).
  const contentMessageId =
    activeTab?.kind === "content" ? activeTab.contentMessageId : null;
  const contentTabText = useActiveMessageContent(contentMessageId);

  // Pay for the workspace body's first fetch only once it's actually shown; keep
  // it mounted afterwards so switching back is instant and state survives.
  const [wsMounted, setWsMounted] = useState(false);
  useEffect(() => {
    if (open && workspaceActive) setWsMounted(true);
  }, [open, workspaceActive]);

  // Drag the left edge to resize. Handwritten pointer tracking (no library);
  // setWidth clamps + persists, so the value is correct mid-drag and on release.
  const onResizeStart = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: PointerEvent) =>
      setWidth(startWidth + (startX - ev.clientX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (!open) return null;

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-border bg-card"
      style={{ width }}
    >
      <Button
        variant="ghost"
        aria-label="拖拽调整面板宽度"
        onPointerDown={onResizeStart}
        className="absolute left-0 top-0 z-10 h-full w-1 min-w-0 cursor-col-resize rounded-none bg-transparent p-0 hover:bg-primary/40"
      />

      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-2 pr-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <WorkspaceTab
            active={workspaceActive}
            onClick={() => setActiveTab(WORKSPACE_TAB_ID)}
          />
          {visibleTabs.map((tab) => (
            <RunTabChip
              key={tab.id}
              tab={tab}
              active={tab.id === activeTab?.id}
              onSelect={() => setActiveTab(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
        </div>
        <SimpleTooltip label="关闭面板 (Ctrl/Cmd+I)">
          <IconButton onClick={closePanel} aria-label="关闭面板">
            <X size={15} />
          </IconButton>
        </SimpleTooltip>
      </div>

      {/* Content area: 指挥台钉在 tab 体上方；下方为工作区 / run·内容详情。 */}
      <div className="flex min-h-0 flex-1 flex-col">
        {command.show && <CommandRegion {...command} />}
        <div className="relative min-h-0 flex-1">
          {wsMounted && (
            <div
              className={`absolute inset-0 ${workspaceActive ? "" : "hidden"}`}
            >
              <WorkspaceMode />
            </div>
          )}
          {activeTab?.kind === "run" && (
            <div className="absolute inset-0 overflow-y-auto">
              <RunDetailBody
                key={activeTab.id}
                messageId={activeTab.messageId}
                runId={activeTab.runId}
              />
            </div>
          )}
          {activeTab?.kind === "content" && (
            // An endpoint bubble (提问 / 最终回答) surfaced from the canvas — the
            // deliverable read as plain Markdown, no run-detail chrome.
            <div className="absolute inset-0 overflow-y-auto p-4">
              <Markdown content={contentTabText} />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

/** The fixed home tab: always first, never closes. */
function WorkspaceTab({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={`shrink-0 gap-1.5 px-2.5 py-1 text-sm font-medium ${
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50"
      }`}
      icon={<FolderOpen size={14} />}
    >
      工作区
    </Button>
  );
}

/** A closable detail tab chip (a run's agent role, or an endpoint's 提问 /
 * 最终回答, + a close affordance). Shared by both detail-tab kinds; a content tab
 * carries an icon (matching its graph endpoint node) so it reads apart from the
 * icon-less run tabs at a glance. */
export function RunTabChip({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: DetailTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  // Content tabs mirror the graph bookends: 你的任务 (UserRound) / CEO 汇总 (Sparkles).
  const icon =
    tab.kind === "content" ? (
      tab.endpoint === "prompt" ? (
        <UserRound size={14} className="shrink-0" />
      ) : (
        <Sparkles size={14} className="shrink-0" />
      )
    ) : null;
  return (
    <div
      className={`group/tab flex shrink-0 items-center rounded-lg ${
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50"
      }`}
    >
      <Button
        variant="ghost"
        onClick={onSelect}
        icon={icon ?? undefined}
        className="h-auto max-w-[140px] truncate rounded-none py-1 pl-2.5 pr-1 text-sm font-normal"
      >
        {tab.title}
      </Button>
      <IconButton
        onClick={onClose}
        aria-label={`关闭 ${tab.title}`}
        className="mr-1 size-5 opacity-0 group-hover/tab:opacity-100"
      >
        <X size={12} />
      </IconButton>
    </div>
  );
}
