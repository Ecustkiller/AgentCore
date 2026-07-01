import { TurnCompare } from "@/components/chat/compare/TurnCompare";
import { IconButton } from "@/components/ui";
import { useActiveMessages } from "@/stores/conversation";
import {
  ExecutionScopeContext,
  hasRevisions,
  isDebate,
  useMessageExecution,
} from "@/stores/execution";
import { type EndpointKind, useSidePanelStore } from "@/stores/sidePanel";
import {
  Handle,
  type NodeProps,
  Position,
  ReactFlowProvider,
} from "@xyflow/react";
import { AlertTriangle, History, Maximize2, X } from "lucide-react";
import { useCallback, useState } from "react";
import {
  countPendingDecisions,
  isTurnRecoverable,
} from "./CanvasDecisionPanel";
import { GraphView } from "./GraphView";

/**
 * The FOCUSED team turn on the persistent conversation canvas (前端UX设计.md
 * §6.1 · LOD「只有聚焦回合画完整 DAG」). Where other turns fold into a {@link
 * import("./TurnSummaryNode")}, the focused one expands IN PLACE on the same canvas
 * surface — its full worker DAG drawn by an embedded {@link GraphView}, reused
 * wholesale (no second graph build).
 *
 * Isolation: the host {@link import("./ConversationCanvas")} is itself a ReactFlow,
 * so the inner GraphView is wrapped in its own {@link ReactFlowProvider} to get a
 * fresh, independent flow store (otherwise it would bind to the outer canvas's
 * store). `embedded` GraphView disables its own pan/zoom and fits-to-width, so the
 * OUTER canvas keeps ownership of pan / zoom / minimap while the inner DAG is a
 * static, drillable preview.
 *
 * Reading in place (§三 ②读答案): clicking the 用户输入 / CEO 汇聚点 endpoint opens its
 * full text (the prompt / the CEO's final answer) in the shared right-docked panel as a
 * content tab — like a worker drill, so a deliverable is read without leaving the canvas
 * and detail always opens to the right. The foot drawer is reserved for the 版本对比 peek
 * ({@link import("@/components/chat/compare/TurnCompare").TurnCompare}, header chip when
 * this turn revised a 非辩论 worker); it splits the
 * fixed node height with the graph (total stays {@link FOCUS_NODE_HEIGHT}, so the host's
 * stacking offsets never shift). A 辩论 turn has no peek here — its full surface is the
 * 统一辩论室 in 放大态 ({@link import("./CanvasZoomedTurn").CanvasZoomedTurn}), reached via
 * the 放大 button. Worker clicks open the run in the same docked panel; the 放大 button
 * hands off to the canvas 放大态 (Route A — not a separate overlay).
 */

/** Fixed footprint so the host can stack turns at known offsets. */
export const FOCUS_NODE_WIDTH = 760;
export const FOCUS_NODE_HEIGHT = 470;
const HEADER_H = 38;
// The 版本对比 drawer (side-by-side revision columns) splits the fixed node height with
// the graph, so the node total is unchanged — the inner preview just gives up rows while
// the drawer is open.
const DRAWER_H = 260;
const BODY_H = FOCUS_NODE_HEIGHT - HEADER_H;

export interface FocusedTurnData {
  messageId: string;
  onMaximize: () => void;
  [key: string]: unknown;
}

export function FocusedTurnNode({ data }: NodeProps) {
  const { messageId, onMaximize } = data as FocusedTurnData;
  const execution = useMessageExecution(messageId);
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const showContentDetail = useSidePanelStore((s) => s.showContentDetail);
  const messages = useActiveMessages();

  // In-place foot drawer: the 版本对比 peek (TurnCompare). Endpoints (提问 / 最终回答)
  // drill to the shared right panel instead (a content tab), not here. A 辩论 turn has no
  // peek here — its full surface is the 统一辩论室 in 放大态 (via the 放大 button), and the
  // 擂台 matrix wouldn't read in this小抽屉 — so the peek is gated to 非辩论 revisions.
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const showRevisions =
    !!execution && hasRevisions(execution) && !isDebate(execution);

  // 图上指挥 (§6.2): on-graph awareness that THIS turn awaits a boss decision or needs
  // 救火 — the host {@link import("./ConversationCanvas")} surfaces the actionable cards
  // in its docked 指挥台; here we only flag them so they read off the focused node.
  const pendingDecisions = countPendingDecisions(
    messages.find((m) => m.id === messageId),
    execution,
  );
  const recoverable = isTurnRecoverable(execution);

  const onNodeSelect = useCallback(
    (runId: string) => {
      const run = execution?.runs.find((r) => r.id === runId);
      const role = execution?.agents.find((a) => a.id === run?.agentId)?.role;
      showRunDetail(messageId, runId, role);
      setRevisionsOpen(false);
    },
    [execution, messageId, showRunDetail],
  );

  // Endpoint drill (提问 / 最终回答): open the bubble in the shared right panel as a
  // content tab — closes any comparison drawer so detail reads in one place.
  const onEndpointSelect = useCallback(
    (contentMessageId: string, title: string, endpoint: EndpointKind) => {
      showContentDetail(messageId, contentMessageId, title, endpoint);
      setRevisionsOpen(false);
    },
    [messageId, showContentDetail],
  );

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-border" />
      <div
        className="overflow-hidden rounded-xl border-2 border-primary bg-card shadow-md"
        style={{ width: FOCUS_NODE_WIDTH }}
      >
        <div
          className="flex items-center gap-2 border-b border-border px-3"
          style={{ height: HEADER_H }}
        >
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {execution?.taskSummary || "团队回合"}
          </span>
          {pendingDecisions > 0 && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              <AlertTriangle size={12} />
              待你拍板{pendingDecisions > 1 ? ` ${pendingDecisions}` : ""}
            </span>
          )}
          {recoverable && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
              <AlertTriangle size={12} />
              待救火
            </span>
          )}
          {showRevisions && (
            <IconButton
              onClick={() => setRevisionsOpen((v) => !v)}
              aria-label="版本对比"
              title="版本对比"
              aria-pressed={revisionsOpen}
              className={
                revisionsOpen ? "bg-accent text-foreground" : undefined
              }
            >
              <History size={15} />
            </IconButton>
          )}
          <IconButton
            onClick={onMaximize}
            aria-label="放大查看"
            title="放大查看"
          >
            <Maximize2 size={15} />
          </IconButton>
        </div>
        {/* nodrag/nowheel: let the inner graph + drawer own their pointer/wheel
            surface inside the node, not the outer canvas's drag/zoom. */}
        <div
          className="nodrag nowheel flex flex-col"
          style={{ height: BODY_H }}
        >
          <div className="min-h-0 flex-1">
            <ReactFlowProvider>
              <ExecutionScopeContext.Provider value={messageId}>
                <GraphView
                  embedded
                  onNodeSelect={onNodeSelect}
                  onEndpointSelect={onEndpointSelect}
                />
              </ExecutionScopeContext.Provider>
            </ReactFlowProvider>
          </div>
          {revisionsOpen && (
            <div
              className="flex flex-col border-t border-border"
              style={{ height: DRAWER_H }}
            >
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  版本对比
                </span>
                <IconButton
                  onClick={() => setRevisionsOpen(false)}
                  aria-label="收起"
                  title="收起"
                >
                  <X size={15} />
                </IconButton>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {execution && (
                  <TurnCompare execution={execution} messageId={messageId} />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </>
  );
}
