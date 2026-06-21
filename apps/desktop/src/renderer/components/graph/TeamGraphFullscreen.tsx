import { SimpleTooltip } from "@/components/ui/tooltip";
import { sendQuickTurn } from "@/services/turns";
import { useActiveGenerating, useActiveMessages } from "@/stores/conversation";
import {
  ExecutionScopeContext,
  useExecutionScope,
  useMessageExecution,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { useUIStore } from "@/stores/ui";
import { ArrowLeft, ArrowUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const graphPrimary = useUIStore((s) => s.graphPrimary);
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
  // Gated by `graphPrimary`.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!graphPrimary || autoOpenedRef.current || !finalAnswerId) return;
    autoOpenedRef.current = true;
    const sp = useSidePanelStore.getState();
    const onRunTab =
      sp.open &&
      sp.tabs.some((t) => t.id === sp.activeTabId && t.messageId === scopeId);
    if (onRunTab) return;
    setEndpoint({ contentMessageId: finalAnswerId, title: "最终回答" });
  }, [graphPrimary, finalAnswerId, scopeId]);

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

        {graphPrimary && (
          <CanvasCommandBar
            onDispatch={() => setFollowing(true)}
            waiting={following && generating}
          />
        )}
      </div>
    </ExecutionScopeContext.Provider>,
    document.body,
  );
}

/**
 * Bottom command bar for the full-screen team graph. Dispatches a turn via
 * {@link sendQuickTurn}; the parent follows the new round in place. Text-only —
 * attachments stay in the main composer. Gated by `graphPrimary`.
 */
function CanvasCommandBar({
  onDispatch,
  waiting,
}: {
  onDispatch: () => void;
  waiting: boolean;
}) {
  const [value, setValue] = useState("");
  // Turns don't stack: while this turn (or any) is generating, the order can be
  // typed but not sent (mirrors the composer). `sendQuickTurn` re-checks too.
  const generating = useActiveGenerating();
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = !generating && value.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    const text = value.trim();
    setValue("");
    if (ref.current) ref.current.style.height = "";
    // Start following before the turn resolves: the new bubble lands almost at once
    // and the parent's follow effect reacts to it. `sendQuickTurn` streams to
    // completion on its own (canSend already gated the guards it re-checks).
    onDispatch();
    void sendQuickTurn(text);
  };

  return (
    <div className="shrink-0 border-t border-border bg-card px-4 py-3">
      {waiting && (
        <div className="mx-auto mb-2 max-w-3xl text-xs text-muted-foreground">
          新回合执行中，画布将自动跟随…
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            e.target.style.height = "0";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="向 CEO 下达下一步指令…"
          className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <SimpleTooltip
          label={generating ? "团队执行中，待完成" : "下达指令 (Enter)"}
        >
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            aria-label="下达指令"
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            <ArrowUp size={18} />
          </button>
        </SimpleTooltip>
      </div>
    </div>
  );
}
