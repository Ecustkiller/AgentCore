import { type DetailTab, useDetailPanelStore } from "@/stores/detailPanel";
import { useExecutionStore } from "@/stores/execution";
import { Users, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { RunDetailBody } from "./detail/RunDetailBody";

/**
 * Conversation detail panel — the passive Layer-2 drill-down beside the chat.
 * The inline collaboration graph is the team's primary surface; clicking one of
 * its nodes pins that run here as a run-detail tab (前端UX设计.md §三). The panel
 * no longer auto-opens and holds no progress / graph tabs of its own — it reads
 * the same execution projection as the graph, so the two stay in lockstep.
 */
export function DetailPanel() {
  const open = useDetailPanelStore((s) => s.open);
  const width = useDetailPanelStore((s) => s.width);
  const tabs = useDetailPanelStore((s) => s.tabs);
  const activeTabId = useDetailPanelStore((s) => s.activeTabId);
  const setActiveTab = useDetailPanelStore((s) => s.setActiveTab);
  const closeTab = useDetailPanelStore((s) => s.closeTab);
  const closePanel = useDetailPanelStore((s) => s.closePanel);
  const setWidth = useDetailPanelStore((s) => s.setWidth);
  const byId = useExecutionStore((s) => s.byId);

  if (!open) return null;

  // A tab survives as long as its own message's execution slot still holds the
  // run. Slots are per-message and persist across turns (§9.3), so a pinned run
  // no longer goes stale when a new turn starts — only if that slot was never
  // built or was reclaimed (the tab can then be closed).
  const visibleTabs = tabs.filter((t) =>
    byId[t.messageId]?.plan?.runs.some((r) => r.id === t.runId),
  );

  const activeTab =
    visibleTabs.find((t) => t.id === activeTabId) ??
    visibleTabs[visibleTabs.length - 1] ??
    null;

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

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-border bg-card"
      style={{ width }}
    >
      <button
        type="button"
        aria-label="拖拽调整面板宽度"
        onPointerDown={onResizeStart}
        className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent hover:bg-primary/40"
      />

      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-2 pr-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {visibleTabs.map((tab) => (
            <TabChip
              key={tab.id}
              tab={tab}
              active={tab.id === activeTab?.id}
              onSelect={() => setActiveTab(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={closePanel}
          title="关闭面板"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {activeTab ? (
          <div className="h-full overflow-y-auto">
            <RunDetailBody
              messageId={activeTab.messageId}
              runId={activeTab.runId}
            />
          </div>
        ) : (
          <EmptyState />
        )}
      </div>
    </aside>
  );
}

function TabChip({
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
      <button
        type="button"
        onClick={onSelect}
        className="max-w-[120px] truncate py-1 pl-2.5 pr-1 text-sm"
      >
        {tab.title}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={`关闭 ${tab.title}`}
        className="mr-1 flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Users size={28} className="text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">未选择运行详情</p>
      <p className="text-xs text-muted-foreground">
        在 AI 回复内的协作图中点击某个 Agent 节点，这里会显示它的运行详情。
      </p>
    </div>
  );
}
