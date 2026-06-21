import { Markdown } from "@/components/chat/Markdown";
import { useActiveMessages } from "@/stores/conversation";
import { ExecutionScopeContext, useMessageExecution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import {
  Handle,
  type NodeProps,
  Position,
  ReactFlowProvider,
} from "@xyflow/react";
import { AlertTriangle, Maximize2, X } from "lucide-react";
import { useCallback, useState } from "react";
import {
  countPendingDecisions,
  isTurnRecoverable,
} from "./CanvasDecisionPanel";
import type { EndpointView } from "./GraphDetailPanel";
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
 * Reading in place (§三 ②读答案): clicking the 用户输入 / CEO 汇聚点 endpoint surfaces
 * its full text (the prompt / the CEO's final answer) in a drawer at the foot of the
 * node — so a deliverable is read without leaving the canvas. The drawer splits the
 * fixed node height with the graph (total stays {@link FOCUS_NODE_HEIGHT}, so the
 * host's stacking offsets never shift). Worker clicks open the run in the shared
 * docked panel; the 全屏 button hands off to the on-demand full-screen overlay.
 */

/** Fixed footprint so the host can stack turns at known offsets. */
export const FOCUS_NODE_WIDTH = 760;
export const FOCUS_NODE_HEIGHT = 470;
const HEADER_H = 38;
const DRAWER_H = 180;
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
  const messages = useActiveMessages();

  // In-place endpoint reading (prompt / final answer). Local — its content is a
  // chat message, not a run, so it needs no shared side-panel tab.
  const [endpoint, setEndpoint] = useState<EndpointView | null>(null);
  const endpointContent = endpoint
    ? (messages.find((m) => m.id === endpoint.contentMessageId)?.content ?? "")
    : "";

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
      setEndpoint(null);
    },
    [execution, messageId, showRunDetail],
  );

  const onEndpointSelect = useCallback(
    (contentMessageId: string, title: string) =>
      setEndpoint({ contentMessageId, title }),
    [],
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
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
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
          <button
            type="button"
            onClick={onMaximize}
            aria-label="全屏查看协作图"
            title="全屏查看协作图"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Maximize2 size={15} />
          </button>
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
                  highlightEndpointMessageId={
                    endpoint?.contentMessageId ?? null
                  }
                />
              </ExecutionScopeContext.Provider>
            </ReactFlowProvider>
          </div>
          {endpoint && (
            <div
              className="flex flex-col border-t border-border"
              style={{ height: DRAWER_H }}
            >
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {endpoint.title}
                </span>
                <button
                  type="button"
                  onClick={() => setEndpoint(null)}
                  aria-label="收起"
                  title="收起"
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X size={15} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <Markdown content={endpointContent} />
              </div>
            </div>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </>
  );
}
