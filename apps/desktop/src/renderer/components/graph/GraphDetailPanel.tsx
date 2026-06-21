import { Markdown } from "@/components/chat/Markdown";
import { RunDetailBody } from "@/components/chat/detail/RunDetailBody";
import { RunTabChip } from "@/components/layout/SidePanel";
import { Button, IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useActiveMessages } from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
} from "react";

/** Full-screen endpoint view: the chat message to surface (the user's prompt /
 * the CEO's final answer) + its tab title. Null shows the drilled run instead. */
export interface EndpointView {
  contentMessageId: string;
  title: string;
}

/**
 * The full-screen graph's in-place detail panel (协作图全屏内联详情).
 *
 * Mirrors the docked {@link SidePanel} but lives INSIDE the full-screen overlay
 * so a node drill opens its detail beside the canvas instead of dropping the
 * overlay (前端UX设计.md §十：全屏 = 大画布 + 回放 + 节点详情). It shows one of two
 * things:
 *
 *  - a **worker run** — reuses the SAME `sidePanel` store (run tabs + active tab
 *    + width) so the node stays lit, RunDetailBody's own「依赖/后续/子任务」
 *    navigation keeps working, and the docked panel shows the very same run once
 *    the user leaves full-screen (one home for run detail);
 *  - an **endpoint** (用户输入 / CEO 汇聚点) — the prompt / final answer rendered
 *    from the chat message, passed in as local `endpoint` state since its
 *    content is a bubble, not a run.
 *
 * Run tabs are scoped to the full-screen graph's message, so a run drilled on
 * another turn never bleeds in. Renders nothing until the user clicks a node.
 */
export function GraphDetailPanel({
  messageId,
  endpoint,
  onCloseEndpoint,
}: {
  messageId: string;
  endpoint: EndpointView | null;
  onCloseEndpoint: () => void;
}) {
  const open = useSidePanelStore((s) => s.open);
  const width = useSidePanelStore((s) => s.width);
  const setWidth = useSidePanelStore((s) => s.setWidth);
  const tabs = useSidePanelStore((s) => s.tabs);
  const activeTabId = useSidePanelStore((s) => s.activeTabId);
  const setActiveTab = useSidePanelStore((s) => s.setActiveTab);
  const closeTab = useSidePanelStore((s) => s.closeTab);
  const closePanel = useSidePanelStore((s) => s.closePanel);
  const byId = useExecutionStore((s) => s.byId);
  const messages = useActiveMessages();
  const [entered, setEntered] = useState(false);

  // This turn's run tabs, still backed by a live run (a reclaimed slot drops its
  // tab — mirrors SidePanel's staleness filter).
  const runTabs = tabs.filter(
    (t) =>
      t.messageId === messageId &&
      byId[t.messageId]?.plan?.runs.some((r) => r.id === t.runId),
  );
  const activeRunTab = runTabs.find((t) => t.id === activeTabId) ?? null;
  // The endpoint view wins when set; otherwise show the drilled run. Hidden when
  // neither applies so the canvas owns the whole overlay (nothing drilled yet,
  // panel closed, or the active tab is the 工作区 home / another turn).
  const showingEndpoint = endpoint !== null;
  const visible = showingEndpoint || (open && activeRunTab !== null);

  // Slide in from the right on first appearance (mirrors the overlay's own
  // entrance, no third-party dep); reset on collapse so the next open re-plays.
  // Swapping between a run and an endpoint keeps `visible` true (the aside stays
  // mounted), so only the content changes — no re-animation.
  useEffect(() => {
    if (!visible) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  if (!visible) return null;

  // Live content (re-read by id so a still-streaming final answer keeps growing).
  const endpointContent = endpoint
    ? (messages.find((m) => m.id === endpoint.contentMessageId)?.content ?? "")
    : "";

  // Drag the left edge to resize (panel is right-docked, so dragging left grows
  // it). Shares the persisted width with the docked panel for a consistent feel.
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
      className={`relative flex shrink-0 flex-col border-l border-border bg-card transition-transform duration-300 motion-reduce:transition-none ${
        entered ? "translate-x-0" : "translate-x-full"
      }`}
      style={{ width }}
    >
      <Button
        variant="ghost"
        aria-label="拖拽调整面板宽度"
        onPointerDown={onResizeStart}
        className="absolute left-0 top-0 z-10 h-full w-1 min-w-0 cursor-col-resize rounded-none bg-transparent p-0 hover:bg-primary/40"
      />

      {endpoint ? (
        <>
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {endpoint.title}
            </span>
            <SimpleTooltip label="收起详情">
              <IconButton
                onClick={onCloseEndpoint}
                aria-label="收起详情"
              >
                <X size={15} />
              </IconButton>
            </SimpleTooltip>
          </div>
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0 overflow-y-auto p-4">
              <Markdown content={endpointContent} />
            </div>
          </div>
        </>
      ) : (
        activeRunTab && (
          <>
            <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-2 pr-1">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {runTabs.map((tab) => (
                  <RunTabChip
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeRunTab.id}
                    onSelect={() => setActiveTab(tab.id)}
                    onClose={() => closeTab(tab.id)}
                  />
                ))}
              </div>
              <SimpleTooltip label="收起详情">
                <IconButton onClick={closePanel} aria-label="收起详情">
                  <X size={15} />
                </IconButton>
              </SimpleTooltip>
            </div>
            <div className="relative min-h-0 flex-1">
              <div className="absolute inset-0 overflow-y-auto">
                <RunDetailBody
                  key={activeRunTab.id}
                  messageId={activeRunTab.messageId}
                  runId={activeRunTab.runId}
                />
              </div>
            </div>
          </>
        )
      )}
    </aside>
  );
}
