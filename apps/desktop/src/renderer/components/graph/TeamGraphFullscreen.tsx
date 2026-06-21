import { useActiveGenerating, useActiveMessages } from "@/stores/conversation";
import {
  ExecutionScopeContext,
  useExecutionScope,
  useMessageExecution,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { Button } from "@/components/ui";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CanvasCommandBar } from "./CanvasCommandBar";
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
  // Scoped turn: opens on the turn it was maximized from (inherited scope). The
  // command bar can switch to FOLLOW a freshly-dispatched turn — issue an order
  // and watch the next round on the same canvas. `scopeId` is re-provided to
  // descendants; this component reads it directly (a child Provider can't reach
  // hooks called in its own body).
  const inheritedScope = useExecutionScope();
  const [scopeId, setScopeId] = useState(inheritedScope);
  const execution = useMessageExecution(scopeId);
  const taskSummary = execution?.taskSummary;
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const [entered, setEntered] = useState(false);
  // Endpoint (用户输入 / CEO 汇聚点) in-place view: the chat message to surface in
  // the panel (prompt / final answer) + its title. Local to full-screen — the
  // content is a chat bubble (not run-scoped), so it needs no shared store tab.
  const [endpoint, setEndpoint] = useState<EndpointView | null>(null);
  const messages = useActiveMessages();
  // The turn's final answer bubble for this execution (mirrors GraphView's
  // `finalAnswer`): the assistant message stamped with this execution id, once the
  // CEO has started writing it (empty until then). Id only — GraphDetailPanel reads
  // the live content by id, so a still-streaming answer keeps growing in the panel.
  const finalAnswerId = useMemo(() => {
    if (!execution) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.executionId === execution.id) {
        return m.content ? m.id : null;
      }
    }
    return null;
  }, [messages, execution]);

  // Worker-node drill-in: pin the run in the shared side panel WITHOUT closing
  // full-screen (mirrors the embedded graph's hand-off, sans `onClose`), so the
  // detail opens in-place beside the canvas. Clears any endpoint view so the run
  // takes the panel.
  const onNodeSelect = useCallback(
    (runId: string) => {
      if (!scopeId) return;
      const run = execution?.runs.find((r) => r.id === runId);
      const role = execution?.agents.find((a) => a.id === run?.agentId)?.role;
      showRunDetail(scopeId, runId, role);
      setEndpoint(null);
    },
    [execution, scopeId, showRunDetail],
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

  // Full-screen has no chat bubble alongside, so auto-surface the CEO final answer
  // in the panel — on enter for a finished turn, or when the answer appears live.
  // Fires once (ref latch) and never clobbers a run the user already drilled into.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current || !finalAnswerId) return;
    autoOpenedRef.current = true;
    const sp = useSidePanelStore.getState();
    const onRunTab =
      sp.open &&
      sp.tabs.some((t) => t.id === sp.activeTabId && t.messageId === scopeId);
    if (onRunTab) return;
    setEndpoint({ contentMessageId: finalAnswerId, title: "最终回答" });
  }, [finalAnswerId, scopeId]);

  // After the command bar dispatches an order, follow the new turn on this canvas —
  // switch scope when its executionId lands, or exit to conversation if the CEO
  // answers directly (no team graph). One-shot per dispatch.
  const generating = useActiveGenerating();
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    if (!following) return;
    let last: (typeof messages)[number] | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        last = messages[i];
        break;
      }
    }
    if (!last || last.id === scopeId) return;
    if (last.executionId) {
      setScopeId(last.id);
      setEndpoint(null);
      autoOpenedRef.current = false;
      setFollowing(false);
    } else if (!last.isStreaming && !generating) {
      setFollowing(false);
      onClose();
    }
  }, [following, messages, generating, scopeId, onClose]);

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
        sp.tabs.some((t) => t.id === sp.activeTabId && t.messageId === scopeId);
      if (panelVisible) sp.closePanel();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, scopeId, endpoint]);

  return createPortal(
    // Re-scope the subtree to the locally-followed turn so GraphView and the detail
    // panel render whichever round this full-screen view is tracking.
    <ExecutionScopeContext.Provider value={scopeId}>
      <div
        className={`fixed inset-0 z-50 flex flex-col bg-background transition-transform duration-300 ${
          entered ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <Button
            variant="neutral"
            size="md"
            onClick={onClose}
            icon={<ArrowLeft size={16} />}
          >
            返回
          </Button>
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
            {/* Remount per scope so a followed turn starts from a clean layout; autoplay
              is the replay entry — only the turn we opened on, never a live follow. */}
            <GraphView
              key={scopeId ?? "none"}
              autoplay={autoplay && scopeId === inheritedScope}
              onClose={onClose}
              onNodeSelect={onNodeSelect}
              onEndpointSelect={onEndpointSelect}
              highlightEndpointMessageId={endpoint?.contentMessageId ?? null}
            />
          </div>
          {scopeId && (
            <GraphDetailPanel
              messageId={scopeId}
              endpoint={endpoint}
              onCloseEndpoint={() => setEndpoint(null)}
            />
          )}
        </div>

        <CanvasCommandBar
          onDispatch={() => setFollowing(true)}
          waiting={following && generating}
        />
      </div>
    </ExecutionScopeContext.Provider>,
    document.body,
  );
}
