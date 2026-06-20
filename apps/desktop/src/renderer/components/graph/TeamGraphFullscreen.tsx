import {
  useActiveExecField,
  useExecutionScope,
  useMessageExecution,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { type EndpointView, GraphDetailPanel } from "./GraphDetailPanel";
import { GraphView } from "./GraphView";

/**
 * Temporary, locally-owned full-screen for the inline team graph. Replaces the
 * old permanent `GraphOverlay` + global `graphOpen`: the inline graph mounts this
 * on demand (maximize button) and tears it down on close, so there is no global
 * graph state to keep in sync.
 *
 * Portaled to <body> so it escapes the message card's `overflow-hidden` (and any
 * transformed/animated ancestor that would otherwise clip a fixed child) and
 * covers the viewport. It hosts the full (non-embedded) `GraphView` — layout
 * toolbar, replay timeline, context menu — beside an in-place run-detail panel
 * ({@link GraphDetailPanel}). Drilling a worker node opens that panel WITHOUT
 * leaving full-screen (`onNodeSelect` hands off to the shared side-panel store,
 * so the node lights up and the docked panel shows the same run on exit — one
 * home for run detail). Endpoint jumps (用户输入 / CEO 汇聚点) still step the
 * overlay aside via `onClose` to reveal their chat bubble; Esc and the 返回
 * button close it too. `autoplay` starts the replay timeline on mount — the
 * inline card's 回放 entry.
 */
export function TeamGraphFullscreen({
  autoplay = false,
  onClose,
}: {
  autoplay?: boolean;
  onClose: () => void;
}) {
  const taskSummary = useActiveExecField((rt) => rt.plan?.taskSummary);
  // Scope (threaded through the portal via ExecutionScopeContext) → this turn's
  // execution, used to title the drilled run tab by the worker's role.
  const messageId = useExecutionScope();
  const execution = useMessageExecution(messageId);
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const [entered, setEntered] = useState(false);
  // Endpoint (用户输入 / CEO 汇聚点) in-place view: the chat message to surface in
  // the panel (prompt / final answer) + its title. Local to full-screen — the
  // content is a chat bubble (not run-scoped), so it needs no shared store tab.
  const [endpoint, setEndpoint] = useState<EndpointView | null>(null);

  // Worker-node drill-in: pin the run in the shared side panel WITHOUT closing
  // full-screen (mirrors the embedded graph's hand-off, sans `onClose`), so the
  // detail opens in-place beside the canvas. Clears any endpoint view so the run
  // takes the panel.
  const onNodeSelect = useCallback(
    (runId: string) => {
      if (!messageId) return;
      const run = execution?.runs.find((r) => r.id === runId);
      const role = execution?.agents.find((a) => a.id === run?.agentId)?.role;
      showRunDetail(messageId, runId, role);
      setEndpoint(null);
    },
    [execution, messageId, showRunDetail],
  );

  // Endpoint drill-in: show the prompt / final answer in-place (no exit). Kept
  // in local state (not the shared run-tab store) since its content is a chat
  // message, not a run.
  const onEndpointSelect = useCallback(
    (contentMessageId: string, title: string) =>
      setEndpoint({ contentMessageId, title }),
    [],
  );

  // Slide in from the right (entrance only, no third-party dep).
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Progressive Esc: collapse the in-place detail first — the endpoint view,
      // then a drilled run from THIS turn — and only once the panel is gone does
      // Esc leave full-screen.
      if (endpoint) {
        setEndpoint(null);
        return;
      }
      const sp = useSidePanelStore.getState();
      const panelVisible =
        sp.open &&
        sp.tabs.some(
          (t) => t.id === sp.activeTabId && t.messageId === messageId,
        );
      if (panelVisible) sp.closePanel();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, messageId, endpoint]);

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex flex-col bg-background transition-transform duration-300 ${
        entered ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft size={16} />
          返回
        </button>
        {taskSummary && (
          <span className="truncate text-sm font-medium text-foreground">
            {taskSummary}
          </span>
        )}
      </div>

      {/* overflow-hidden clips the detail panel while it slides in from the
          right, so the entrance never flashes a horizontal scrollbar. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1">
          <GraphView
            autoplay={autoplay}
            onClose={onClose}
            onNodeSelect={onNodeSelect}
            onEndpointSelect={onEndpointSelect}
            highlightEndpointMessageId={endpoint?.contentMessageId ?? null}
          />
        </div>
        {messageId && (
          <GraphDetailPanel
            messageId={messageId}
            endpoint={endpoint}
            onCloseEndpoint={() => setEndpoint(null)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
