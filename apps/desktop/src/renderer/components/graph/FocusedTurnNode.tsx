import { DebateBody } from "@/components/chat/DebateCompare";
import { Markdown } from "@/components/chat/Markdown";
import { RevisionCompare } from "@/components/chat/RevisionCompare";
import { IconButton } from "@/components/ui";
import { useActiveMessages } from "@/stores/conversation";
import {
  ExecutionScopeContext,
  hasRevisions,
  isDebate,
  useMessageExecution,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import {
  Handle,
  type NodeProps,
  Position,
  ReactFlowProvider,
} from "@xyflow/react";
import {
  AlertTriangle,
  History,
  Maximize2,
  MessagesSquare,
  X,
} from "lucide-react";
import { useCallback, useState } from "react";
import {
  countPendingDecisions,
  isTurnRecoverable,
} from "./CanvasDecisionPanel";
import { GraphView } from "./GraphView";
import type { EndpointView } from "./constants";

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
 * node — so a deliverable is read without leaving the canvas. The same foot drawer also
 * hosts 版本对比 ({@link RevisionCompare}, header chip when this turn revised a worker)
 * and, for a 辩论 turn, 交锋叙事 ({@link DebateBody}: 决策简报 + 叙事线, header chip) —
 * the debate's full surface lives in 放大态, this is the overview-node peek. The three
 * (endpoint / 版本对比 / 交锋叙事) are mutually exclusive; the drawer splits the fixed
 * node height with the graph (total stays {@link FOCUS_NODE_HEIGHT}, so the host's
 * stacking offsets never shift). Worker clicks open the run in the shared docked panel;
 * the 放大 button hands off to the canvas 放大态 ({@link
 * import("./CanvasZoomedTurn").CanvasZoomedTurn}, Route A — not a separate overlay).
 */

/** Fixed footprint so the host can stack turns at known offsets. */
export const FOCUS_NODE_WIDTH = 760;
export const FOCUS_NODE_HEIGHT = 470;
const HEADER_H = 38;
const DRAWER_H = 180;
// 版本对比 needs more room than an endpoint read (side-by-side version columns). It
// still splits the fixed node height with the graph, so the node total is unchanged —
// the inner preview just gives up rows while the comparison is open.
const REVISION_DRAWER_H = 260;
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

  // In-place foot drawer: either endpoint reading (prompt / final answer — a chat
  // message, so no shared side-panel tab) OR 版本对比 (RevisionCompare). Mutually
  // exclusive; opening one closes the other.
  const [endpoint, setEndpoint] = useState<EndpointView | null>(null);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [debateOpen, setDebateOpen] = useState(false);
  const endpointContent = endpoint
    ? (messages.find((m) => m.id === endpoint.contentMessageId)?.content ?? "")
    : "";
  const showRevisions = !!execution && hasRevisions(execution);
  const showDebate = !!execution && isDebate(execution);

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
      setRevisionsOpen(false);
      setDebateOpen(false);
    },
    [execution, messageId, showRunDetail],
  );

  const onEndpointSelect = useCallback(
    (contentMessageId: string, title: string) => {
      setEndpoint({ contentMessageId, title });
      setRevisionsOpen(false);
      setDebateOpen(false);
    },
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
          {showDebate && (
            <IconButton
              onClick={() => {
                setEndpoint(null);
                setRevisionsOpen(false);
                setDebateOpen((v) => !v);
              }}
              aria-label="交锋叙事"
              title="交锋叙事"
              aria-pressed={debateOpen}
              className={debateOpen ? "bg-accent text-foreground" : undefined}
            >
              <MessagesSquare size={15} />
            </IconButton>
          )}
          {showRevisions && (
            <IconButton
              onClick={() => {
                setEndpoint(null);
                setDebateOpen(false);
                setRevisionsOpen((v) => !v);
              }}
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
                  highlightEndpointMessageId={
                    endpoint?.contentMessageId ?? null
                  }
                />
              </ExecutionScopeContext.Provider>
            </ReactFlowProvider>
          </div>
          {(endpoint || revisionsOpen || debateOpen) && (
            <div
              className="flex flex-col border-t border-border"
              style={{
                height:
                  revisionsOpen || debateOpen ? REVISION_DRAWER_H : DRAWER_H,
              }}
            >
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {revisionsOpen
                    ? "版本对比"
                    : debateOpen
                      ? "交锋叙事"
                      : endpoint?.title}
                </span>
                <IconButton
                  onClick={() => {
                    setEndpoint(null);
                    setRevisionsOpen(false);
                    setDebateOpen(false);
                  }}
                  aria-label="收起"
                  title="收起"
                >
                  <X size={15} />
                </IconButton>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {revisionsOpen && execution ? (
                  <RevisionCompare
                    execution={execution}
                    messageId={messageId}
                    bare
                  />
                ) : debateOpen && execution ? (
                  <DebateBody execution={execution} messageId={messageId} />
                ) : (
                  <Markdown content={endpointContent} />
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
