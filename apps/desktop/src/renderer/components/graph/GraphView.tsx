import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { NODE_HEIGHT, computeLayout, fitWidthBox } from "@/lib/elk-layout";
import { estimateTokens, formatCost, headText, tailText } from "@/lib/format";
import { useActiveMessages, useConversationStore } from "@/stores/conversation";
import {
  type Execution,
  type RunStatus,
  useActiveExecField,
  useExecutionScope,
  useProjectedExecution,
} from "@/stores/execution";
import {
  type GraphEdge,
  type GraphLayout,
  useGraphStore,
} from "@/stores/graph";
import { useSidePanelStore } from "@/stores/sidePanel";
import { useUsageStore } from "@/stores/usage";
import {
  Background,
  type Edge,
  type Node,
  type NodeChange,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Crosshair,
  ListTree,
  Maximize2,
  MoveHorizontal,
  ScanSearch,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentNode } from "./AgentNode";
import { EndpointNode } from "./EndpointNode";
import { StepEdge } from "./StepEdge";
import { Timeline } from "./Timeline";

// 节点 type 名避开 ReactFlow 内建保留名（input / output / default / group）：用
// 这些名会令 `@xyflow/react/dist/style.css` 的默认节点样式（1px #1a192b 黑边 +
// width:150px + padding:10px）漏到自定义节点上，在 210px 卡片背后画出一个黑色方框。
// 故用户输入端点用 `userInput` 而非 `input`。
const nodeTypes = {
  agent: AgentNode,
  userInput: EndpointNode,
  captain: EndpointNode,
};
const edgeTypes = { step: StepEdge };

// The one synthetic graph-only bookend (no scheduled Run): the user's input
// root. The sink 汇聚点 is the real CEO captain run (always declared in the
// top-level delegate batch), so it needs no synthetic stand-in. Real run ids are
// server UUIDs, so this never collides.
const INPUT_ID = "__input__";
const isEndpointId = (id: string): boolean => id === INPUT_ID;

// Honor the OS "reduce motion" setting for the embedded fit animation (read
// fresh so an OS toggle takes effect without a reload). Guards matchMedia for
// non-DOM (test) contexts. The rest of the graph's motion is gated in globals.css.
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Layout choices for the canvas toolbar (default left-right first). Each maps to
// a distinct ELK algorithm in `computeLayout`; the active one is highlighted and
// persisted.
const LAYOUT_OPTIONS: {
  kind: GraphLayout;
  label: string;
  icon: React.ReactNode;
}[] = [
  { kind: "leftright", label: "左右流", icon: <MoveHorizontal size={14} /> },
  { kind: "tree", label: "树形布局", icon: <ListTree size={14} /> },
];

/**
 * The CEO captain root 汇聚点 emits its own run lifecycle, but its `run_started`
 * fires before the delegate batch's `run_plan` exists, so the live stream drops
 * that frame. Its node status is therefore *derived* from the team: "summarizing"
 * once every worker is done and "done" once the whole turn ends — which also
 * keeps the live and replayed graphs identical. The captain run itself is
 * excluded from the worker-completion check (it is the sink, not a worker).
 */
function deriveCaptainStatus(
  execution: Execution,
  captainId: string,
): RunStatus {
  if (execution.status === "failed") return "failed";
  if (execution.status === "cancelled") return "cancelled";
  if (execution.status === "completed") return "completed";
  const workers = execution.runs.filter((r) => r.id !== captainId);
  const allDone =
    workers.length > 0 && workers.every((r) => r.status === "completed");
  return allDone ? "running" : "pending";
}

interface GraphViewProps {
  /**
   * Embedded in the message (vs. the full-screen overlay). Drops the replay
   * timeline and the layout toolbar — in the message column a node click hands
   * off to {@link onNodeSelect} (opens a run-detail tab in the conversation
   * panel) so the narrow column is not split by a second pane.
   */
  embedded?: boolean;
  /**
   * Worker-node drill-in hand-off: when set, a node click reports the run id
   * instead of opening the run detail itself, and it does NOT close the
   * surrounding overlay. Both the embedded message graph (opens a docked
   * run-detail tab) and the full-screen overlay (opens the in-place
   * {@link GraphDetailPanel}) pass this so a drill never drops their surface.
   * When omitted, a node click opens the run detail here then calls `onClose`.
   * Endpoint (input / captain) clicks use {@link onEndpointSelect} instead.
   */
  onNodeSelect?: (runId: string) => void;
  /**
   * Endpoint drill-in hand-off for the full-screen overlay: when set, clicking
   * the 用户输入 / CEO 汇聚点 endpoint reports the chat message to surface (the
   * prompt / the final answer) + a title, so the overlay shows it in the
   * in-place panel WITHOUT leaving full-screen. The embedded graph leaves it
   * unset and keeps the jump-to-chat focus (that bubble is already in the
   * column, so a panel would just duplicate it).
   */
  onEndpointSelect?: (contentMessageId: string, title: string) => void;
  /**
   * Full-screen only: the chat message id currently surfaced in the in-place
   * endpoint view ({@link GraphDetailPanel}), so the matching endpoint node
   * (用户输入 / CEO 汇聚点) lights up like a drilled worker. Matched against the
   * input prompt / final-answer message ids. While set, it also suppresses the
   * worker glow (the panel shows the endpoint, not a run), so exactly one node
   * is lit. Null / omitted → no endpoint is lit (embedded graph, or a worker
   * run is showing instead).
   */
  highlightEndpointMessageId?: string | null;
  /** Embedded only: report the canvas height the graph wants (fit-to-width of
   * the laid-out bbox, clamped) so the wrapper can size its box to each graph's
   * real footprint. `overflowing` is true when the graph is taller than the
   * clamp ceiling, so the wrapper can hint there is more (fade + 全屏). */
  onMeasure?: (m: { height: number; overflowing: boolean }) => void;
  /** Dismiss the surrounding temporary full-screen (non-embedded only); set by
   * the inline graph's fullscreen wrapper. Endpoint jumps + node drill-ins call
   * it so the overlay steps aside to reveal the chat (where the run detail and
   * the jumped-to bubble live). */
  onClose?: () => void;
  /** Start the replay timeline playing on mount — the full-screen "回放" entry
   * (non-embedded only). */
  autoplay?: boolean;
}

export function GraphView({
  embedded = false,
  onNodeSelect,
  onEndpointSelect,
  highlightEndpointMessageId = null,
  onMeasure,
  onClose,
  autoplay = false,
}: GraphViewProps = {}) {
  // The message whose graph this is (§9.3). Threaded from the inline graph via
  // ExecutionScopeContext (survives the full-screen portal), so focus + detail
  // mutations target the right per-message slot — live or replayed.
  const messageId = useExecutionScope();
  const execution = useProjectedExecution();
  const hasFrames = useActiveExecField((rt) => rt.frames.length > 0);
  // Latest projected runs — incl. synthesized「修订 vN」revisions (乙 热修 P4), which
  // are NOT in the plan — for the structure-gated layout effect to read without
  // re-running on every streamed token. `structuralKey` below changes when a
  // revision node appears, so the effect re-runs and reads the fresh list here.
  const projectedRunsRef = useRef(execution?.runs);
  projectedRunsRef.current = execution?.runs;
  // Layout is per-graph view state (see stores/graph.ts): each inline graph owns
  // its own ELK positions, so multiple message graphs never clobber one another.
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  // The laid-out graph's natural bbox (方案 D): drives the embedded canvas's
  // fit-to-width zoom + height. Null until the first layout commits.
  const [bbox, setBbox] = useState<{ width: number; height: number } | null>(
    null,
  );
  const setLayout = useCallback(
    (
      nextPositions: Record<string, { x: number; y: number }>,
      nextEdges: GraphEdge[],
    ) => {
      setPositions(nextPositions);
      setEdges(nextEdges);
    },
    [],
  );
  // 方案 D（真居中）：每个节点按真实测量高度回中到 ELK 给它的固定槽位，使连线锚点（位于
  // 各自真实高度 50% 处）落在同一条槽位中线上 → 1→1 直连边笔直、接真·垂直正中。只读测量
  // 高度、不重跑布局：槽位不变 → 零级联；节点流式长高时是绕固定锚点对称扩张，邻居不动。
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodeHeights((prev) => {
      let next = prev;
      for (const c of changes) {
        if (c.type === "dimensions" && c.dimensions) {
          const h = c.dimensions.height;
          if (h > 0 && prev[c.id] !== h) {
            if (next === prev) next = { ...prev };
            next[c.id] = h;
          }
        }
      }
      return next;
    });
  }, []);
  // Only the algorithm choice is global (a shared, persisted user preference).
  const layoutKind = useGraphStore((s) => s.layoutKind);
  const setLayoutKind = useGraphStore((s) => s.setLayoutKind);
  // Left-right flow re-anchors node handles to the horizontal axis.
  const handleDirection =
    layoutKind === "leftright" ? "horizontal" : "vertical";
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  // Drill into a run through the conversation's right-side detail panel — the
  // single home for run detail. The embedded graph hands off via `onNodeSelect`
  // (also a `showRunDetail`); the full-screen overlay calls this directly and
  // then steps aside (`onClose`) so the panel shows behind it.
  const showRunDetailHere = useCallback(
    (runId: string) => {
      if (!messageId) return;
      const run = execution?.runs.find((r) => r.id === runId);
      const role = execution?.agents.find((a) => a.id === run?.agentId)?.role;
      showRunDetail(messageId, runId, role);
    },
    [execution, messageId, showRunDetail],
  );
  // Node highlight has one source: the side panel's active run tab for THIS
  // turn. Both the embedded graph and the full-screen overlay drill into that
  // single panel (the overlay then steps aside), so the lit node is whatever the
  // panel currently shows — switching / closing tabs, selecting the 工作区 home
  // tab (not in `tabs`, so this returns null), or hiding the panel moves or
  // drops the highlight automatically.
  const highlightRunId = useSidePanelStore((s) => {
    if (!s.open) return null;
    const active = s.tabs.find((t) => t.id === s.activeTabId);
    return active && active.messageId === messageId ? active.runId : null;
  });
  // While an endpoint (提问 / 最终回答) fills the in-place panel, IT — not a run —
  // is on screen (GraphDetailPanel lets the endpoint win over an open run tab),
  // so suppress the worker glow: exactly one node lights, matching what the panel
  // shows. Clearing the endpoint (Esc / 收起) restores the run's glow if its tab
  // is still open. Inert in the embedded graph (no endpoint id ever set).
  const litRunId = highlightEndpointMessageId ? null : highlightRunId;
  // The single FX rate (§7.5) that turns each run's nano-USD total into the ¥
  // chip on its node; one rate for the whole graph keeps the money consistent.
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const messages = useActiveMessages();
  const focusMessage = useConversationStore((s) => s.focusMessage);
  // The CEO captain's reply streams to the chat bubble (not run-scoped), so the
  // 汇聚点 node's "output" is this turn's assistant answer — found by the
  // execution id the bubble was stamped with on run_plan. Drives the captain
  // node's preview and its jump-to-answer click.
  const finalAnswer = useMemo(() => {
    if (!execution) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.executionId === execution.id) {
        // Only usable once the captain has actually started writing the answer;
        // an empty bubble (workers still running) leaves the node inert.
        return m.content ? { id: m.id, content: m.content } : null;
      }
    }
    return null;
  }, [messages, execution]);
  // The input bookend likewise has no run: it stands in for the user's prompt
  // that opened this turn — the last user message before this turn's answer
  // bubble. Drives the input node's jump-to-question click (the bubble already
  // renders the prompt in full, so the jump *is* the "expand").
  const taskMessage = useMemo(() => {
    if (!execution) return null;
    const answerIdx = messages.findIndex(
      (m) => m.role === "assistant" && m.executionId === execution.id,
    );
    if (answerIdx <= 0) return null;
    for (let i = answerIdx - 1; i >= 0; i--) {
      if (messages[i].role === "user") return { id: messages[i].id };
    }
    return null;
  }, [messages, execution]);
  // The CEO captain root run (kind "captain") is the graph's 汇聚点: the turn's
  // reply engine that every worker hangs under. Declared in the top-level
  // delegate batch, so it is on the graph from plan time. Its reply lives in the
  // chat bubble (not run-scoped), so its node jumps to that answer rather than
  // drilling a bubble-scoped run detail.
  const captainRun = useMemo(
    () => execution?.runs.find((r) => r.kind === "captain") ?? null,
    [execution],
  );
  const [layoutReady, setLayoutReady] = useState(false);
  const rfRef = useRef<ReactFlowInstance | null>(null);
  // Embedded fit-to-width plumbing (方案 D): the canvas element (whose width is
  // the message column) is measured live, and the React Flow instance is held in
  // state so the viewport effect re-runs once the canvas is ready. `overflowing`
  // toggles the bottom fade when the graph is taller than the clamp ceiling.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [colWidth, setColWidth] = useState(0);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  // First fit snaps (from React Flow's default viewport); later fits — when the
  // team grows mid-stream and the graph relays out — animate so the canvas eases
  // to its new framing instead of jumping. Per-message instance, so a fresh turn
  // / re-expand snaps again.
  const viewportSettledRef = useRef(false);
  // Right-click menu target. `null` is the pane (empty-canvas) menu; a string is
  // the right-clicked node. Radix ContextMenu owns the open state + cursor
  // positioning; React Flow's handlers below only record *which* surface was
  // right-clicked so the content can vary.
  const [menuNodeId, setMenuNodeId] = useState<string | null>(null);

  // Layout depends only on graph *shape* (run ids + dependencies), so it is
  // recomputed when the plan changes — not on every streamed token.
  const structuralKey = useMemo(
    () =>
      execution
        ? execution.runs
            .map(
              (s) => `${s.id}:${s.dependsOn.join(",")}:${s.parentRunId ?? ""}`,
            )
            .join("|")
        : "",
    [execution],
  );

  useEffect(() => {
    if (!structuralKey) {
      setLayout({}, []);
      setBbox(null);
      setLayoutReady(false);
      // A cleared graph's next fit should snap, not animate from a stale frame.
      viewportSettledRef.current = false;
      return;
    }
    // Projected runs (plan runs + synthesized「修订」revisions); revisions are not
    // in the plan, so the layout must read the projection, not plan.runs.
    const runs = projectedRunsRef.current ?? [];
    // The CEO captain root run is the graph's 汇聚点; the worker DAG is laid out
    // around it, and every worker with no downstream wires INTO it as the sink.
    const captainId = runs.find((r) => r.kind === "captain")?.id ?? null;
    const workerRuns = runs.filter((r) => r.id !== captainId);
    const workerIds = new Set(workerRuns.map((r) => r.id));
    // A「修订 vN」续写 (乙 热修 P4) hangs off its original like a sub-worker, but it is
    // a VERSION, not a delegation — it gets its own dotted edge below and stays off
    // the bookend flow.
    const isRevision = (r: { revision?: number }): boolean =>
      (r.revision ?? 0) > 0;
    // A sub-worker's parent is another WORKER on this graph (its captain worker,
    // 阶段2 nested delegation). A top-level worker's parent is the CEO captain
    // root — excluded from this set — so it reads as a main-wave node, not a
    // nested sub-task. (A lone task / null parent is top-level too.) A revision
    // also has a worker parent but is excluded — it is not a delegation.
    const isSub = (r: {
      id: string;
      parentRunId?: string | null;
      revision?: number;
    }): boolean =>
      !isRevision(r) &&
      !!r.parentRunId &&
      r.parentRunId !== r.id &&
      workerIds.has(r.parentRunId);
    // Bookend ONLY top-level workers: neither a nested sub-worker nor a revision is
    // top-level, so both stay off the input → … → captain flow.
    const topWorkers = workerRuns.filter((r) => !isSub(r) && !isRevision(r));
    const nodeIds = workerRuns.map((s) => s.id);
    // 辩论/审查 分列对置 (前端UX设计.md §四): when the batch carries stance tags, order
    // the worker nodes 正方 → (untagged) → 反方 so ELK (considerModelOrder) bands the
    // two sides into facing groups instead of interleaving them. Inert for非辩论.
    const debate = workerRuns.some((r) => r.stance != null);
    if (debate) {
      const rank = (id: string) => {
        const st = workerRuns.find((r) => r.id === id)?.stance;
        return st === "pro" ? 0 : st === "con" ? 2 : 1;
      };
      nodeIds.sort((a, b) => rank(a) - rank(b));
    }
    const rawEdges: GraphEdge[] = workerRuns.flatMap((run) =>
      run.dependsOn.map((depId) => ({
        id: `${depId}->${run.id}`,
        source: depId,
        target: run.id,
        kind: "dep" as const,
      })),
    );

    // Delegation edges (阶段2 父子分组): a captain worker → each of its nested
    // sub-workers. Drawn distinctly (dashed, see StepEdge) so a sub-team reads as
    // grouped under its parent; the layered layout then clusters the sub-workers
    // right after the captain. Sub-workers never touch the bookends below.
    for (const r of workerRuns) {
      if (isSub(r)) {
        rawEdges.push({
          id: `${r.parentRunId}=>${r.id}`,
          source: r.parentRunId as string,
          target: r.id,
          kind: "delegate",
        });
      }
    }

    // Revision edges (乙 热修 P4): the original worker → each of its「修订 vN」续写,
    // drawn dotted (StepEdge) so a re-do reads as a version of the same node. The
    // layered layout then clusters the revisions right after their original.
    for (const r of workerRuns) {
      if (isRevision(r) && r.revisionOf) {
        rawEdges.push({
          id: `${r.revisionOf}~>${r.id}`,
          source: r.revisionOf,
          target: r.id,
          kind: "revision",
        });
      }
    }

    // Bookend ONLY the top-level worker DAG so the graph reads as a full
    // collaboration story: user input → team waves → CEO 汇聚点. The input root
    // is always synthetic (the prompt has no run); the sink is the real CEO
    // captain run. The synthetic input id is guarded everywhere a real run id is
    // expected (clicks, run-detail, context menu).
    if (topWorkers.length > 0 && captainId) {
      const dependedOn = new Set<string>();
      for (const r of topWorkers)
        for (const dep of r.dependsOn) dependedOn.add(dep);
      nodeIds.push(INPUT_ID, captainId);
      for (const r of topWorkers) {
        if (r.dependsOn.length === 0) {
          rawEdges.push({
            id: `${INPUT_ID}->${r.id}`,
            source: INPUT_ID,
            target: r.id,
            kind: "dep",
          });
        }
        if (!dependedOn.has(r.id)) {
          rawEdges.push({
            id: `${r.id}->${captainId}`,
            source: r.id,
            target: captainId,
            kind: "dep",
          });
        }
      }
    }

    let cancelled = false;
    // Pin the bookends so the CEO 汇聚点 sink always lands past every worker
    // (incl. a nested sub-team's leaf sub-workers, which otherwise tie its
    // layer). Inert when unbookended — neither id is then a node. See elk-layout.
    computeLayout(nodeIds, rawEdges, layoutKind, debate, {
      source: INPUT_ID,
      sink: captainId ?? undefined,
    }).then((result) => {
      if (cancelled) return;
      setLayout(result.positions, rawEdges);
      setBbox({ width: result.width, height: result.height });
      setLayoutReady(true);
    });
    return () => {
      cancelled = true;
    };
    // `structuralKey` already changes with the scoped message (run ids are
    // unique), so it covers a message switch — no need to also depend on
    // `messageId` (which is constant per graph instance anyway).
  }, [structuralKey, layoutKind, setLayout]);

  // Measure the canvas width live (方案 D): it is the message column, which the
  // right detail panel / window resize can change, so the fit-to-width zoom must
  // track it rather than assume a fixed column. Embedded only — the full-screen
  // overlay keeps React Flow's own fitView.
  useEffect(() => {
    if (!embedded) return;
    const el = containerRef.current;
    if (!el) return;
    setColWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setColWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [embedded]);

  // Fit-to-width viewport (方案 D): zoom only shrinks when the graph is wider
  // than the column (never upscales), so node size is consistent across messages;
  // the box height then follows the graph's real footprint at that zoom, clamped.
  // When the graph is shorter than its box it is centered; when it overflows the
  // ceiling it is top-aligned and a fade hints there is more (→ 全屏).
  useEffect(() => {
    if (!embedded || !rfInstance || !bbox || colWidth <= 0 || !layoutReady) {
      return;
    }
    const fit = fitWidthBox(bbox.width, bbox.height, colWidth);
    const x = Math.max(0, (colWidth - fit.renderedWidth) / 2);
    const y =
      fit.renderedHeight <= fit.height
        ? (fit.height - fit.renderedHeight) / 2
        : 0;
    // Animate every fit except the first (which would fly in from the default
    // viewport). 200ms matches the box's height transition, so frame + box ease
    // together as the team grows — unless the user asked to reduce motion, then
    // every fit snaps.
    const animate = viewportSettledRef.current && !prefersReducedMotion();
    rfInstance.setViewport(
      { x, y, zoom: fit.zoom },
      animate ? { duration: 200 } : undefined,
    );
    viewportSettledRef.current = true;
    setOverflowing(fit.overflowing);
    onMeasure?.({ height: fit.height, overflowing: fit.overflowing });
  }, [embedded, rfInstance, bbox, colWidth, layoutReady, onMeasure]);

  // The single-node drill-in: hand off to the embedded panel, or toggle in-graph
  // focus. Shared by mouse clicks and keyboard (Enter/Space) activation.
  const activateNode = useCallback(
    (id: string) => {
      // The synthetic bookends have no run to drill into — each stands in for a
      // real chat message (the user's prompt / the CEO's answer), so activating
      // one jumps the conversation to that bubble and drops the full-screen
      // overlay so the chat is visible (in the embedded panel it is already
      // alongside). The target bubble renders its text in full, so the jump is
      // also the "expand".
      if (id === INPUT_ID) {
        if (!taskMessage) return;
        // Full-screen: surface the prompt in the in-place panel (no exit);
        // embedded: jump to the prompt bubble already in the column.
        if (onEndpointSelect) {
          onEndpointSelect(taskMessage.id, "提问");
          return;
        }
        focusMessage(taskMessage.id);
        if (!embedded) onClose?.();
        return;
      }
      // The captain 汇聚点 is a real run, but its reply lives in the chat bubble
      // (not run-scoped), so activating it surfaces the final answer — like the
      // input node surfaces the prompt — rather than drilling a sparse detail.
      if (captainRun && id === captainRun.id) {
        if (!finalAnswer) return;
        if (onEndpointSelect) {
          onEndpointSelect(finalAnswer.id, "最终回答");
          return;
        }
        focusMessage(finalAnswer.id);
        if (!embedded) onClose?.();
        return;
      }
      // Defensive: the synthetic input endpoint carries no run.
      if (isEndpointId(id)) return;
      if (onNodeSelect) {
        onNodeSelect(id);
        return;
      }
      // Full-screen overlay: open the run in the conversation detail panel, then
      // step aside so it shows behind the overlay (one home for run detail).
      showRunDetailHere(id);
      onClose?.();
    },
    [
      onNodeSelect,
      onEndpointSelect,
      showRunDetailHere,
      finalAnswer,
      taskMessage,
      captainRun,
      focusMessage,
      embedded,
      onClose,
    ],
  );

  // A node click always drills (no modifier multi-select branch): React Flow's
  // built-in element selection is disabled below, so the graph has no selection
  // gesture to defer to — every click is a single-node drill-in.
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => activateNode(node.id),
    [activateNode],
  );

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      setMenuNodeId(node.id);
    },
    [],
  );

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      setMenuNodeId(null);
    },
    [],
  );

  const fitView = useCallback(() => {
    rfRef.current?.fitView({ padding: 0.2, duration: 300 });
  }, []);

  const centerNode = useCallback((id: string) => {
    const node = rfRef.current?.getNode(id);
    if (!node) return;
    const w = node.measured?.width ?? 210;
    const h = node.measured?.height ?? 64;
    rfRef.current?.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
      zoom: 1.2,
      duration: 300,
    });
  }, []);

  // `F` fits the whole graph to the viewport (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      fitView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitView]);

  // Full-screen only: when the canvas width changes — the in-place run-detail
  // panel (GraphDetailPanel) opening / closing / being resized beside it — refit
  // so the DAG re-centers into the width it actually has instead of sliding
  // behind the panel. Debounced so a resize-drag settles before the fit; the
  // first (mount) observation is skipped because `fitView` already framed it,
  // and the overlay's transform-only slide-in doesn't change layout width so it
  // never triggers a spurious fit. Embedded mode keeps its own width effect.
  useEffect(() => {
    if (embedded) return;
    const el = containerRef.current;
    if (!el) return;
    let lastWidth = Math.round(el.clientWidth);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (!settled) {
        settled = true;
        lastWidth = w;
        return;
      }
      if (w <= 0 || w === lastWidth) return;
      lastWidth = w;
      clearTimeout(timer);
      timer = setTimeout(() => fitView(), 160);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [embedded, fitView]);

  const captainStatus = useMemo<RunStatus | null>(
    () =>
      execution && captainRun
        ? deriveCaptainStatus(execution, captainRun.id)
        : null,
    [execution, captainRun],
  );

  const flowNodes = useMemo<Node[]>(() => {
    if (!execution) return [];
    // 方案 D：把节点从「ELK 槽位顶对齐」改为「按真实高度居中到槽位」。槽位中心 =
    // slot.y + NODE_HEIGHT/2；displayY = slot.y + (NODE_HEIGHT − 实测高)/2 使节点真实
    // 中心落到槽位中心，连线锚点随之齐平。测量到达前回退到原始槽位（顶对齐，仅首帧）。
    const placed = (id: string) => {
      const slot = positions[id];
      if (!slot) return undefined;
      const h = nodeHeights[id];
      return h ? { x: slot.x, y: slot.y + (NODE_HEIGHT - h) / 2 } : slot;
    };
    // The captain root run renders as the 汇聚点 (below), not as a worker node.
    const workerRuns = execution.runs.filter((r) => r.id !== captainRun?.id);
    // 子任务判定只看 worker 之间的父子关系，必须排除 captain：CEO 的顶层 worker 的
    // parentRunId 正是 captain root，若把 captain 算进来，每个顶层 worker 都会被误判
    // 成「子任务」(与 layout 处的 isSub 对齐，二者曾不一致)。
    const workerIdSet = new Set(workerRuns.map((r) => r.id));
    const nodes: Node[] = workerRuns.map((run, i) => {
      const agent = execution.agents.find((a) => a.id === run.agentId);
      const output = agent ? agent.outputChunks.join("") : "";
      // Reasoning streams run-scoped too (run_reasoning_delta); DeepSeek emits the
      // whole reasoning before any content, so the node falls back to this tail
      // while a running worker is still thinking (output empty) — see AgentNode.
      const reasoning = agent ? agent.reasoningChunks.join("") : "";
      const focused = litRunId === run.id;
      // 乙 热修 P4: a「修订 vN」续写 node is badged as a version (not a teammate); it
      // has a worker parent too, so it must be excluded from the 子任务 check below.
      const isRevision = run.revision > 0;
      // 阶段2: a nested sub-worker (its parent is another WORKER on this graph) is
      // badged so it reads as a delegated sub-task, not a top-level teammate.
      const isSubtask =
        !isRevision &&
        !!run.parentRunId &&
        run.parentRunId !== run.id &&
        workerIdSet.has(run.parentRunId);
      return {
        id: run.id,
        type: "agent",
        position: placed(run.id) ?? { x: 0, y: 0 },
        data: {
          agentId: run.agentId,
          role: agent?.role ?? run.agentId,
          modelPreference: agent?.modelPreference,
          reasoningEffort: agent?.reasoningEffort,
          runId: run.id,
          status: run.status,
          isAnimating: run.status === "running",
          task: run.task,
          outputPreview: tailText(output),
          reasoningPreview: tailText(reasoning),
          // Live tool-call assembly (run_tool_progress): the only signal while a
          // worker streams a long file body as args — neither content nor reasoning.
          toolProgress: agent?.toolProgress ?? null,
          tokenCount: estimateTokens(output),
          toolCount: agent?.toolCalls.length ?? 0,
          focused,
          model: run.model,
          durationMs: run.durationMs,
          realTokens: run.usage ? run.usage.input + run.usage.output : 0,
          costText:
            run.cost && run.cost.total > 0
              ? formatCost(run.cost.total, cnyPerUsd)
              : undefined,
          handleDirection,
          isSubtask,
          // 乙 热修 P4: badge a 续写 node「修订 vN」(version number from the wire flag).
          isRevision,
          revision: run.revision,
          // 辩论/审查 side tag (前端UX设计.md §四): badges the node 正方/反方; null on
          // ordinary teammates.
          stance: run.stance,
          // 结构化挂起 2a (7.2A): a `checkpoint_after` pause that fired after this run
          // → drives the node's「待放行 / 已放行 / 已停止」pause badge; null otherwise.
          checkpoint: run.checkpoint,
          // Input endpoint is index 0, so workers start at 1.
          enterIndex: i + 1,
          onActivate: () => activateNode(run.id),
        },
      } as Node;
    });

    // Endpoints render only once ELK has placed them (positions present).
    if (execution.runs.length > 0) {
      const inputPos = placed(INPUT_ID);
      if (inputPos) {
        nodes.push({
          id: INPUT_ID,
          type: "userInput",
          position: inputPos,
          data: {
            variant: "input",
            status: "completed",
            label: execution.taskSummary,
            handleDirection,
            enterIndex: 0,
            // Lit when the panel surfaces this turn's prompt (mirrors a worker's
            // glow); matched by the input bookend's stand-in message id.
            focused:
              !!taskMessage && highlightEndpointMessageId === taskMessage.id,
            onActivate: taskMessage ? () => activateNode(INPUT_ID) : undefined,
          },
        } as Node);
      }
      // The CEO captain 汇聚点: the climax node previewing the team's deliverable
      // (the chat-bubble answer, since the captain's reply is bubble-scoped, not
      // run-scoped). Status is derived from team completion; clicking jumps to
      // that answer rather than drilling a sparse run detail.
      if (captainRun && captainStatus) {
        const captainPos = placed(captainRun.id);
        if (captainPos) {
          nodes.push({
            id: captainRun.id,
            type: "captain",
            position: captainPos,
            data: {
              variant: "captain",
              status: captainStatus,
              label: "",
              // 取答案开头而非末尾：成稿答案开头即结论/主旨，长答案取末尾会截出半句
              // 乱码（与 worker 运行中取 tail 显「正在写什么」的语义相反）。
              preview: finalAnswer ? headText(finalAnswer.content) : "",
              handleDirection,
              enterIndex: workerRuns.length + 1,
              // Lit when the panel surfaces the final answer; matched by the
              // answer's bubble id (the captain's reply is bubble-scoped).
              focused:
                !!finalAnswer && highlightEndpointMessageId === finalAnswer.id,
              onActivate: finalAnswer
                ? () => activateNode(captainRun.id)
                : undefined,
            },
          } as Node);
        }
      }
    }

    return nodes;
  }, [
    execution,
    positions,
    nodeHeights,
    cnyPerUsd,
    litRunId,
    highlightEndpointMessageId,
    captainStatus,
    captainRun,
    handleDirection,
    activateNode,
    finalAnswer,
    taskMessage,
  ]);

  const flowEdges = useMemo<Edge[]>(() => {
    return edges.map((e) => {
      const animated =
        e.target === captainRun?.id
          ? captainStatus === "running"
          : execution?.runs.find((s) => s.id === e.target)?.status ===
            "running";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "step",
        animated,
        data: { animated, kind: e.kind ?? "dep" },
      } as Edge;
    });
  }, [edges, execution, captainStatus, captainRun]);

  // The embedded graph lives inside the scrollable chat column, so it behaves as
  // a static preview: no wheel/pinch/double-click zoom and no drag-pan, plus
  // preventScrolling=false so the wheel scrolls the conversation instead of being
  // captured by the canvas. All zoom/pan exploration happens in full-screen.
  const interactionProps = embedded
    ? {
        zoomOnScroll: false,
        zoomOnPinch: false,
        zoomOnDoubleClick: false,
        panOnDrag: false,
        preventScrolling: false,
        // The fit-to-width zoom of a wide DAG can fall below React Flow's default
        // 0.5 floor; lower it so our programmatic setViewport is never clamped
        // (the user can't zoom here anyway, so a low floor is inert).
        minZoom: 0.05,
      }
    : {};

  if (!execution) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">暂无执行任务</p>
          <p className="mt-1 text-xs text-muted-foreground">
            发送多 Agent 任务后，协作图将在此显示
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={containerRef} className="relative flex-1">
            {layoutReady && (
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={(inst) => {
                  rfRef.current = inst;
                  setRfInstance(inst);
                }}
                onNodesChange={onNodesChange}
                onNodeClick={onNodeClick}
                onNodeContextMenu={onNodeContextMenu}
                onPaneContextMenu={onPaneContextMenu}
                fitView={!embedded}
                nodesDraggable={false}
                nodesConnectable={false}
                nodesFocusable={false}
                // Node highlight has ONE source: the side panel's active run tab
                // (projected into each node's `focused`). React Flow's built-in
                // click-selection would paint a second, competing outline (two lit
                // nodes, or a stray outline on the endpoints that only jump), so
                // it is off — clicks still drill via onNodeClick.
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
                {...interactionProps}
              >
                <Background gap={20} size={1} />
              </ReactFlow>
            )}

            {/* Over-tall graph hint (方案 D): the inline canvas caps its height, so a
            graph taller than the ceiling is top-aligned and faded at the bottom
            to signal「还有更多」— open 全屏 to see the whole DAG. */}
            {embedded && overflowing && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
            )}

            {!embedded && (
              // Right-clicking the floating toolbar shouldn't open the canvas context
              // menu (it isn't a node or the pane), so stop the event from reaching
              // the ContextMenuTrigger wrapping the canvas.
              <div
                className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-card/95 p-1 shadow-sm backdrop-blur"
                onContextMenu={(e) => e.stopPropagation()}
              >
                {LAYOUT_OPTIONS.map((opt) => (
                  <SimpleTooltip key={opt.kind} label={opt.label}>
                    <button
                      type="button"
                      onClick={() => setLayoutKind(opt.kind)}
                      aria-label={opt.label}
                      aria-pressed={layoutKind === opt.kind}
                      className={`flex size-7 items-center justify-center rounded-lg ${
                        layoutKind === opt.kind
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      {opt.icon}
                    </button>
                  </SimpleTooltip>
                ))}
                <div className="mx-0.5 h-5 w-px bg-border" />
                <SimpleTooltip label="适应画布 (F)">
                  <button
                    type="button"
                    onClick={fitView}
                    aria-label="适应画布"
                    className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Maximize2 size={14} />
                  </button>
                </SimpleTooltip>
              </div>
            )}

            {!embedded && hasFrames && (
              <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
                <Timeline autoPlay={autoplay} />
              </div>
            )}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          {menuNodeId !== null && (
            <>
              {!isEndpointId(menuNodeId) && menuNodeId !== captainRun?.id && (
                <ContextMenuItem
                  onSelect={() => {
                    if (onNodeSelect) onNodeSelect(menuNodeId);
                    else {
                      showRunDetailHere(menuNodeId);
                      onClose?.();
                    }
                  }}
                >
                  <ScanSearch size={14} className="shrink-0" />
                  <span className="flex-1 truncate">查看详情</span>
                </ContextMenuItem>
              )}
              {menuNodeId === INPUT_ID && taskMessage && (
                <ContextMenuItem onSelect={() => activateNode(INPUT_ID)}>
                  <ScanSearch size={14} className="shrink-0" />
                  <span className="flex-1 truncate">查看完整提问</span>
                </ContextMenuItem>
              )}
              {menuNodeId === captainRun?.id && finalAnswer && (
                <ContextMenuItem onSelect={() => activateNode(captainRun.id)}>
                  <ScanSearch size={14} className="shrink-0" />
                  <span className="flex-1 truncate">查看最终回答</span>
                </ContextMenuItem>
              )}
              <ContextMenuItem onSelect={() => centerNode(menuNodeId)}>
                <Crosshair size={14} className="shrink-0" />
                <span className="flex-1 truncate">居中此节点</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => fitView()}>
            <Maximize2 size={14} className="shrink-0" />
            <span className="flex-1 truncate">适应画布</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
