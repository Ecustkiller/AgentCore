import { Markdown } from "@/components/chat/Markdown";
import { RunDetailBody } from "@/components/chat/detail/RunDetailBody";
import { Button, IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { WorkspaceMode } from "@/components/workspace/WorkspacePanel";
import { useActiveMessages } from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import {
  type DetailTab,
  WORKSPACE_TAB_ID,
  useSidePanelStore,
} from "@/stores/sidePanel";
import { FolderOpen, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
} from "react";

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
  const byId = useExecutionStore((s) => s.byId);
  const messages = useActiveMessages();

  // A detail tab survives only while it belongs to the live conversation: a run
  // tab while its message's execution slot still holds the run (§9.3); a content
  // tab while its turn slot is loaded — so a reclaimed slot / a switched
  // conversation drops the stale tab.
  const visibleTabs = tabs.filter((t) =>
    t.kind === "run"
      ? byId[t.messageId]?.plan?.runs.some((r) => r.id === t.runId)
      : !!byId[t.messageId]?.plan,
  );
  const activeTab =
    activeTabId === WORKSPACE_TAB_ID
      ? null
      : (visibleTabs.find((t) => t.id === activeTabId) ?? null);
  // Workspace shows whenever no detail tab is active (the home, or the active tab
  // went stale and dropped out).
  const workspaceActive = activeTab === null;

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
            <Markdown
              content={
                messages.find((m) => m.id === activeTab.contentMessageId)
                  ?.content ?? ""
              }
            />
          </div>
        )}
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

/** A closable run-detail tab (the agent's role + a close affordance). Exported
 * so the full-screen graph's in-place detail panel renders the same chip. */
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
        className="h-auto max-w-[120px] truncate rounded-none py-1 pl-2.5 pr-1 text-sm font-normal"
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
