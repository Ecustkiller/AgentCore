import { GraphView } from "@/components/graph/GraphView";
import { type DetailTab, useDetailPanelStore } from "@/stores/detailPanel";
import { type Execution, useProjectedExecution } from "@/stores/execution";
import { useUIStore } from "@/stores/ui";
import { Maximize2, Users, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ProgressTab } from "./detail/ProgressTab";
import { RunDetailBody } from "./detail/RunDetailBody";

/**
 * Conversation detail panel — the docked Layer-2 surface ("manage the team")
 * that lives beside the chat. Holds a dynamic set of tabs (progress overview /
 * per-run drill-down / embedded graph) opened on demand from the task card,
 * roster and graph; reads the same execution projection as those surfaces, so
 * all of them stay in lockstep without a second data source.
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
  const execution = useProjectedExecution();

  if (!open) return null;

  const isMulti = execution != null && execution.planType === "multi_agent";

  // Drop run-detail tabs whose run no longer exists in the live execution
  // (e.g. a stale tab carried across turns); singleton tabs always apply.
  const visibleTabs = isMulti
    ? tabs.filter(
        (t) =>
          t.kind !== "run-detail" ||
          execution.runs.some((r) => r.id === t.runId),
      )
    : [];

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
        {isMulti && activeTab ? (
          <TabBody tab={activeTab} execution={execution} />
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

function TabBody({ tab, execution }: { tab: DetailTab; execution: Execution }) {
  if (tab.kind === "task-graph") return <PanelGraph execution={execution} />;

  return (
    <div className="h-full overflow-y-auto">
      {tab.kind === "task-progress" ? (
        <ProgressTab execution={execution} />
      ) : tab.runId ? (
        <RunDetailBody runId={tab.runId} />
      ) : null}
    </div>
  );
}

/** Embedded collaboration graph: clicking a node opens its run-detail tab; the
 * maximise button hands off to the full-screen overlay. */
function PanelGraph({ execution }: { execution: Execution }) {
  const openGraph = useUIStore((s) => s.openGraph);
  const showRunDetail = useDetailPanelStore((s) => s.showRunDetail);

  const onNodeSelect = (runId: string) => {
    const run = execution.runs.find((r) => r.id === runId);
    const role = execution.agents.find((a) => a.id === run?.agentId)?.role;
    showRunDetail(runId, role);
  };

  return (
    <div className="relative h-full">
      <GraphView embedded onNodeSelect={onNodeSelect} />
      <button
        type="button"
        onClick={openGraph}
        title="最大化"
        className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
      >
        <Maximize2 size={14} />
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Users size={28} className="text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">当前回合没有多 Agent 协作</p>
      <p className="text-xs text-muted-foreground">
        发起一个需要团队协作的任务后，这里会显示每个 Agent 的进度与详情。
      </p>
    </div>
  );
}
