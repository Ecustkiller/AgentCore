import {
  ContextMenu,
  MenuDivider,
  MenuItem,
} from "@/components/sidebar/ContextMenu";
import { computeLayout } from "@/lib/elk-layout";
import { estimateTokens, formatCost, tailText } from "@/lib/format";
import { useActiveMessages, useConversationStore } from "@/stores/conversation";
import { useDetailPanelStore } from "@/stores/detailPanel";
import {
  type Execution,
  type RunStatus,
  execRuntime,
  useActiveExecField,
  useExecutionScope,
  useExecutionStore,
  useProjectedExecution,
} from "@/stores/execution";
import {
  type GraphEdge,
  type GraphLayout,
  useGraphStore,
} from "@/stores/graph";
import { useUsageStore } from "@/stores/usage";
import {
  Background,
  Controls,
  type Edge,
  type Node,
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

const nodeTypes = {
  agent: AgentNode,
  input: EndpointNode,
  synthesis: EndpointNode,
};
const edgeTypes = { step: StepEdge };

// Synthetic graph-only bookends (no scheduled Run): the user's input root and
// the CEO synthesis sink. Real run ids are server UUIDs, so these never collide.
const INPUT_ID = "__input__";
const SYNTHESIS_ID = "__synthesis__";
const isEndpointId = (id: string): boolean =>
  id === INPUT_ID || id === SYNTHESIS_ID;

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
 * The CEO synthesis node has no scheduled Run (the captain is the chat loop),
 * so its status is derived: it is "summarizing" once every worker is done and
 * "done" once the whole turn ends — mirroring execution-level state.
 */
function deriveSynthesisStatus(execution: Execution): RunStatus {
  if (execution.status === "failed") return "failed";
  if (execution.status === "cancelled") return "cancelled";
  if (execution.status === "completed") return "completed";
  const allDone =
    execution.runs.length > 0 &&
    execution.runs.every((r) => r.status === "completed");
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
  /** Node-click handler for embedded mode; falls back to in-graph focus. */
  onNodeSelect?: (runId: string) => void;
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
  onClose,
  autoplay = false,
}: GraphViewProps = {}) {
  // The message whose graph this is (§9.3). Threaded from the inline graph via
  // ExecutionScopeContext (survives the full-screen portal), so focus + detail
  // mutations target the right per-message slot — live or replayed.
  const messageId = useExecutionScope();
  const execution = useProjectedExecution();
  const hasFrames = useActiveExecField((rt) => rt.frames.length > 0);
  // Layout is per-graph view state (see stores/graph.ts): each inline graph owns
  // its own ELK positions, so multiple message graphs never clobber one another.
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [edges, setEdges] = useState<GraphEdge[]>([]);
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
  // Only the algorithm choice is global (a shared, persisted user preference).
  const layoutKind = useGraphStore((s) => s.layoutKind);
  const setLayoutKind = useGraphStore((s) => s.setLayoutKind);
  // Left-right flow re-anchors node handles to the horizontal axis.
  const handleDirection =
    layoutKind === "leftright" ? "horizontal" : "vertical";
  const showRunDetail = useDetailPanelStore((s) => s.showRunDetail);
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
  // Node highlight has one source: the conversation panel's active run-detail
  // tab for THIS turn. Both the embedded graph and the full-screen overlay drill
  // into that single panel (the overlay then steps aside), so the lit node is
  // whatever the panel currently shows — switching / closing tabs or hiding the
  // panel moves or drops the highlight automatically.
  const highlightRunId = useDetailPanelStore((s) => {
    if (!s.open) return null;
    const active =
      s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[s.tabs.length - 1];
    return active && active.messageId === messageId ? active.runId : null;
  });
  // The single FX rate (§7.5) that turns each run's nano-USD total into the ¥
  // chip on its node; one rate for the whole graph keeps the money consistent.
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const messages = useActiveMessages();
  const focusMessage = useConversationStore((s) => s.focusMessage);
  // The CEO synthesis has no scheduled Run (the captain is the chat loop), so
  // its "output" is this turn's assistant answer — found by the execution id the
  // bubble was stamped with on run_plan. Drives the synthesis node's preview and
  // its jump-to-answer click.
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
  // Phase B (D3): once the CEO's 汇总 is a real run (kind "synthesis"), it is the
  // graph's actual 汇聚点 — replacing the synthetic sink. It is drillable like any
  // run (its detail shows the 汇总过程 reasoning + overview output), so its node
  // carries the real run id and routes through the normal activate path. Absent
  // before the CEO resumes to synthesize → the synthetic bookend stands in.
  const synthesisRun = useMemo(
    () => execution?.runs.find((r) => r.kind === "synthesis") ?? null,
    [execution],
  );
  const [layoutReady, setLayoutReady] = useState(false);
  const rfRef = useRef<ReactFlowInstance | null>(null);
  // Right-click menu anchor. `nodeId === null` is the pane (empty-canvas) menu.
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    nodeId: string | null;
  } | null>(null);
  const menuNodeId = menu?.nodeId ?? null;

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
      setLayoutReady(false);
      return;
    }
    const runs =
      execRuntime(useExecutionStore.getState(), messageId).plan?.runs ?? [];
    // The CEO synthesis run (Phase B) is the real 汇聚点; the worker DAG is laid
    // out around it. Workers wire INTO it as the sink instead of the synthetic
    // bookend, which is dropped once the real run exists.
    const synthId = runs.find((r) => r.kind === "synthesis")?.id ?? null;
    const runIds = new Set(runs.map((r) => r.id));
    // A sub-worker's parent is another run on THIS graph (its captain worker,
    // 阶段2 nested delegation); a top-level worker's "parent" is the CEO captain
    // run, which has no node here (parentRunId ∉ runIds) or is null. Only real
    // sub-workers are grouped under a parent — the rest are the main wave DAG.
    const isSub = (r: { id: string; parentRunId?: string | null }): boolean =>
      !!r.parentRunId && r.parentRunId !== r.id && runIds.has(r.parentRunId);
    const workerRuns = runs.filter((r) => r.id !== synthId);
    const topWorkers = workerRuns.filter((r) => !isSub(r));
    const nodeIds = runs.map((s) => s.id);
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

    // Bookend ONLY the top-level worker DAG so the graph reads as a full
    // collaboration story: user input → team waves → CEO synthesis. The input
    // root is always synthetic (the prompt has no run); the sink is the real
    // synthesis run when present, else a synthetic node. Synthetic ids are guarded
    // everywhere a real run id is expected (clicks, run-detail, context menu).
    if (topWorkers.length > 0) {
      const dependedOn = new Set<string>();
      for (const r of topWorkers)
        for (const dep of r.dependsOn) dependedOn.add(dep);
      const sinkId = synthId ?? SYNTHESIS_ID;
      nodeIds.push(INPUT_ID);
      if (!synthId) nodeIds.push(SYNTHESIS_ID);
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
            id: `${r.id}->${sinkId}`,
            source: r.id,
            target: sinkId,
            kind: "dep",
          });
        }
      }
    }

    let cancelled = false;
    computeLayout(nodeIds, rawEdges, layoutKind).then((layouted) => {
      if (cancelled) return;
      setLayout(layouted, rawEdges);
      setLayoutReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [structuralKey, layoutKind, setLayout, messageId]);

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
        focusMessage(taskMessage.id);
        if (!embedded) onClose?.();
        return;
      }
      if (id === SYNTHESIS_ID) {
        if (!finalAnswer) return;
        focusMessage(finalAnswer.id);
        if (!embedded) onClose?.();
        return;
      }
      // Defensive: any other endpoint id carries no run.
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
      showRunDetailHere,
      finalAnswer,
      taskMessage,
      focusMessage,
      embedded,
      onClose,
    ],
  );

  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      // Modifier-click is React Flow's multi-select gesture; let it just toggle
      // selection without also hijacking the single-node focus/detail flow.
      if (event.shiftKey || event.metaKey || event.ctrlKey) return;
      activateNode(node.id);
    },
    [activateNode],
  );

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
    },
    [],
  );

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, nodeId: null });
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

  const synthesisStatus = useMemo<RunStatus | null>(
    () => (execution ? deriveSynthesisStatus(execution) : null),
    [execution],
  );

  const flowNodes = useMemo<Node[]>(() => {
    if (!execution) return [];
    // The synthesis run renders as the 汇聚点 (below), not as a worker node.
    const workerRuns = execution.runs.filter((r) => r.id !== synthesisRun?.id);
    const runIdSet = new Set(execution.runs.map((r) => r.id));
    const nodes: Node[] = workerRuns.map((run, i) => {
      const agent = execution.agents.find((a) => a.id === run.agentId);
      const output = agent ? agent.outputChunks.join("") : "";
      const focused = highlightRunId === run.id;
      // 阶段2: a nested sub-worker (its parent is another run on this graph) is
      // badged so it reads as a delegated sub-task, not a top-level teammate.
      const isSubtask =
        !!run.parentRunId &&
        run.parentRunId !== run.id &&
        runIdSet.has(run.parentRunId);
      return {
        id: run.id,
        type: "agent",
        position: positions[run.id] ?? { x: 0, y: 0 },
        data: {
          agentId: run.agentId,
          role: agent?.role ?? run.agentId,
          modelPreference: agent?.modelPreference,
          reasoningEffort: agent?.reasoningEffort,
          runId: run.id,
          status: run.status,
          isAnimating: run.status === "running",
          outputPreview: tailText(output),
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
          // Input endpoint is index 0, so workers start at 1.
          enterIndex: i + 1,
          onActivate: () => activateNode(run.id),
        },
      } as Node;
    });

    // Endpoints render only once ELK has placed them (positions present).
    if (execution.runs.length > 0) {
      const inputPos = positions[INPUT_ID];
      if (inputPos) {
        nodes.push({
          id: INPUT_ID,
          type: "input",
          position: inputPos,
          data: {
            variant: "input",
            status: "completed",
            label: execution.taskSummary,
            handleDirection,
            enterIndex: 0,
            onActivate: taskMessage ? () => activateNode(INPUT_ID) : undefined,
          },
        } as Node);
      }
      if (synthesisRun) {
        // The real 汇聚点: a CEO run drilled into like any node (its detail shows
        // the 汇总过程 + overview). Previews its own streamed output, falling back
        // to the answer bubble's tail before the overview starts.
        const synthPos = positions[synthesisRun.id];
        const synthAgent = execution.agents.find(
          (a) => a.id === synthesisRun.agentId,
        );
        const synthOutput = synthAgent ? synthAgent.outputChunks.join("") : "";
        if (synthPos) {
          nodes.push({
            id: synthesisRun.id,
            type: "synthesis",
            position: synthPos,
            data: {
              variant: "synthesis",
              status: synthesisRun.status,
              label: "",
              preview:
                tailText(synthOutput) ||
                (finalAnswer ? tailText(finalAnswer.content) : ""),
              actionLabel: "查看汇总过程",
              handleDirection,
              enterIndex: workerRuns.length + 1,
              onActivate: () => activateNode(synthesisRun.id),
            },
          } as Node);
        }
      } else {
        const synthPos = positions[SYNTHESIS_ID];
        if (synthPos && synthesisStatus) {
          nodes.push({
            id: SYNTHESIS_ID,
            type: "synthesis",
            position: synthPos,
            data: {
              variant: "synthesis",
              status: synthesisStatus,
              label: "",
              preview: finalAnswer ? tailText(finalAnswer.content) : "",
              handleDirection,
              enterIndex: workerRuns.length + 1,
              onActivate: finalAnswer
                ? () => activateNode(SYNTHESIS_ID)
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
    cnyPerUsd,
    highlightRunId,
    synthesisStatus,
    synthesisRun,
    handleDirection,
    activateNode,
    finalAnswer,
    taskMessage,
  ]);

  const flowEdges = useMemo<Edge[]>(() => {
    return edges.map((e) => {
      const animated =
        e.target === SYNTHESIS_ID
          ? synthesisStatus === "running"
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
  }, [edges, execution, synthesisStatus]);

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
      <div className="relative flex-1">
        {layoutReady && (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={(inst) => {
              rfRef.current = inst;
            }}
            onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={onPaneContextMenu}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}

        {!embedded && (
          <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-card/95 p-1 shadow-sm backdrop-blur">
            {LAYOUT_OPTIONS.map((opt) => (
              <button
                key={opt.kind}
                type="button"
                onClick={() => setLayoutKind(opt.kind)}
                title={opt.label}
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
            ))}
          </div>
        )}

        {!embedded && hasFrames && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
            <Timeline autoPlay={autoplay} />
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menuNodeId !== null && (
            <>
              {!isEndpointId(menuNodeId) && (
                <MenuItem
                  icon={<ScanSearch size={14} />}
                  label="查看详情"
                  onSelect={() => {
                    if (onNodeSelect) onNodeSelect(menuNodeId);
                    else {
                      showRunDetailHere(menuNodeId);
                      onClose?.();
                    }
                    setMenu(null);
                  }}
                />
              )}
              {menuNodeId === INPUT_ID && taskMessage && (
                <MenuItem
                  icon={<ScanSearch size={14} />}
                  label="查看完整提问"
                  onSelect={() => {
                    activateNode(INPUT_ID);
                    setMenu(null);
                  }}
                />
              )}
              {(menuNodeId === SYNTHESIS_ID ||
                menuNodeId === synthesisRun?.id) &&
                finalAnswer && (
                  <MenuItem
                    icon={<ScanSearch size={14} />}
                    label="查看最终回答"
                    onSelect={() => {
                      focusMessage(finalAnswer.id);
                      if (!embedded) onClose?.();
                      setMenu(null);
                    }}
                  />
                )}
              <MenuItem
                icon={<Crosshair size={14} />}
                label="居中此节点"
                onSelect={() => {
                  centerNode(menuNodeId);
                  setMenu(null);
                }}
              />
              <MenuDivider />
            </>
          )}
          <MenuItem
            icon={<Maximize2 size={14} />}
            label="适应画布"
            onSelect={() => {
              fitView();
              setMenu(null);
            }}
          />
        </ContextMenu>
      )}
    </div>
  );
}
