import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/elk-layout";
import { detectReviewConcern } from "@/lib/reviewConcern";
import { estimateTokens, formatCost, headText, tailText } from "@/lib/format";
import type { Execution, RunStatus } from "@/stores/execution";
import type { GraphEdge } from "@/stores/graph";
import type { Edge, Node } from "@xyflow/react";
import { INPUT_ID } from "./constants";
import { deriveArtifacts, resolveHandoff } from "./helpers";

export interface FlowGraphProjectionInput {
  execution: Execution;
  positions: Record<string, { x: number; y: number }>;
  nodeHeights: Record<string, number>;
  nodeSizes: Record<string, { width: number; height: number }>;
  timelineLayout: boolean;
  handleDirection: "horizontal" | "vertical";
  cnyPerUsd: number;
  litRunId: string | null;
  litEndpointMessageId: string | null;
  captainRun: { id: string } | null;
  captainStatus: RunStatus | null;
  finalAnswer: { id: string; content: string } | null;
  taskMessage: { id: string } | null;
  activateNode: (id: string) => void;
  hoveredNodeId?: string | null;
  edges?: GraphEdge[];
}

export interface FlowEdgeProjectionInput extends FlowGraphProjectionInput {
  edges: GraphEdge[];
}

/** Direct neighbors of a hovered node (for edge/node highlight). */
function hoverRelatedIds(
  hoveredNodeId: string | null | undefined,
  edges: GraphEdge[],
): Set<string> | null {
  if (!hoveredNodeId) return null;
  const related = new Set([hoveredNodeId]);
  for (const e of edges) {
    if (e.source === hoveredNodeId) related.add(e.target);
    if (e.target === hoveredNodeId) related.add(e.source);
  }
  return related;
}

/** Cross-axis center for port sorting (y for horizontal flow, x for vertical). */
function crossCenterOf(
  id: string,
  positions: Record<string, { x: number; y: number }>,
  horizontal: boolean,
): number {
  const p = positions[id];
  if (!p) return 0;
  return horizontal ? p.y + NODE_HEIGHT / 2 : p.x + NODE_WIDTH / 2;
}

/** Assign evenly spaced handle ports for fan-out / fan-in edges. */
function computeEdgePorts(
  edges: GraphEdge[],
  positions: Record<string, { x: number; y: number }>,
  horizontal: boolean,
): Map<
  string,
  {
    sourcePortIndex: number;
    sourcePortTotal: number;
    targetPortIndex: number;
    targetPortTotal: number;
  }
> {
  const result = new Map<
    string,
    {
      sourcePortIndex: number;
      sourcePortTotal: number;
      targetPortIndex: number;
      targetPortTotal: number;
    }
  >();

  const bySource = new Map<string, GraphEdge[]>();
  const byTarget = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const srcArr = bySource.get(e.source);
    if (srcArr) srcArr.push(e);
    else bySource.set(e.source, [e]);
    const tgtArr = byTarget.get(e.target);
    if (tgtArr) tgtArr.push(e);
    else byTarget.set(e.target, [e]);
  }

  const sourcePort = new Map<string, { index: number; total: number }>();
  for (const group of bySource.values()) {
    const sorted = [...group].sort(
      (a, b) =>
        crossCenterOf(a.target, positions, horizontal) -
        crossCenterOf(b.target, positions, horizontal),
    );
    const total = sorted.length;
    sorted.forEach((e, index) => {
      sourcePort.set(e.id, { index, total });
    });
  }

  const targetPort = new Map<string, { index: number; total: number }>();
  for (const group of byTarget.values()) {
    const sorted = [...group].sort(
      (a, b) =>
        crossCenterOf(a.source, positions, horizontal) -
        crossCenterOf(b.source, positions, horizontal),
    );
    const total = sorted.length;
    sorted.forEach((e, index) => {
      targetPort.set(e.id, { index, total });
    });
  }

  for (const e of edges) {
    const sp = sourcePort.get(e.id) ?? { index: 0, total: 1 };
    const tp = targetPort.get(e.id) ?? { index: 0, total: 1 };
    result.set(e.id, {
      sourcePortIndex: sp.index,
      sourcePortTotal: sp.total,
      targetPortIndex: tp.index,
      targetPortTotal: tp.total,
    });
  }
  return result;
}

/** Pure projection: Execution + layout → React Flow nodes. */
export function projectFlowNodes({
  execution,
  positions,
  nodeHeights,
  nodeSizes,
  timelineLayout,
  handleDirection,
  cnyPerUsd,
  litRunId,
  litEndpointMessageId,
  captainRun,
  captainStatus,
  finalAnswer,
  taskMessage,
  activateNode,
  hoveredNodeId,
  edges: layoutEdges = [],
}: FlowGraphProjectionInput): Node[] {
  const placed = (id: string) => {
    const slot = positions[id];
    if (!slot) return undefined;
    if (timelineLayout) return slot;
    const h = nodeHeights[id];
    return h ? { x: slot.x, y: slot.y + (NODE_HEIGHT - h) / 2 } : slot;
  };

  const workerRuns = execution.runs.filter((r) => r.id !== captainRun?.id);
  const workerIdSet = new Set(workerRuns.map((r) => r.id));
  const hoverRelated = hoverRelatedIds(hoveredNodeId, layoutEdges);
  const hoverDimmed = (id: string) =>
    hoverRelated != null && !hoverRelated.has(id);
  const nodes: Node[] = [];

  for (const [i, run] of workerRuns.entries()) {
    const pos = placed(run.id);
    if (!pos) continue;
    const agent = execution.agents.find((a) => a.id === run.agentId);
    const output = agent ? agent.outputChunks.join("") : "";
    const reasoning = agent ? agent.reasoningChunks.join("") : "";
    const reviewConcern =
      output.length >= 12 ? detectReviewConcern(output) : null;
    const focused = litRunId === run.id;
    const isRevision = run.revision > 0;
    const isSubtask =
      !isRevision &&
      !!run.parentRunId &&
      run.parentRunId !== run.id &&
      workerIdSet.has(run.parentRunId);
    const size = nodeSizes[run.id];
    nodes.push({
      id: run.id,
      type: "agent",
      position: pos,
      ...(timelineLayout && size
        ? { style: { width: size.width, height: size.height } }
        : {}),
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
        toolProgress: agent?.toolProgress ?? null,
        tokenCount: estimateTokens(output),
        toolCount: agent?.toolCalls.length ?? 0,
        artifacts: agent ? deriveArtifacts(agent.toolCalls) : [],
        focused,
        layoutMode: timelineLayout ? "timeline" : "dependency",
        nodeWidth: size?.width,
        model: run.model,
        durationMs: run.durationMs,
        realTokens: run.usage ? run.usage.input + run.usage.output : 0,
        costText:
          run.cost && run.cost.total > 0
            ? formatCost(run.cost.total, cnyPerUsd)
            : undefined,
        handleDirection,
        isSubtask,
        isRevision,
        revision: run.revision,
        revised: run.revised,
        stance: run.stance,
        checkpoint: run.checkpoint,
        escalationPending: run.escalations.filter((e) => e.status === "pending")
          .length,
        escalationRaised: run.escalations.filter((e) => e.status === "raised")
          .length,
        reviewConcern,
        enterIndex: i + 1,
        hoverDimmed: hoverDimmed(run.id),
        onActivate: () => activateNode(run.id),
      },
    } as Node);
  }

  if (execution.runs.length > 0) {
    const inputPos = placed(INPUT_ID);
    if (inputPos) {
      const inputSize = nodeSizes[INPUT_ID];
      nodes.push({
        id: INPUT_ID,
        type: "userInput",
        position: inputPos,
        ...(timelineLayout && inputSize
          ? { style: { width: inputSize.width, height: inputSize.height } }
          : {}),
        data: {
          variant: "input",
          status: "completed",
          label: execution.taskSummary,
          handleDirection,
          enterIndex: 0,
          hoverDimmed: hoverDimmed(INPUT_ID),
          focused: !!taskMessage && litEndpointMessageId === taskMessage.id,
          onActivate: taskMessage ? () => activateNode(INPUT_ID) : undefined,
        },
      } as Node);
    }
    if (captainRun && captainStatus) {
      const captainPos = placed(captainRun.id);
      if (captainPos) {
        const captainSize = nodeSizes[captainRun.id];
        nodes.push({
          id: captainRun.id,
          type: "captain",
          position: captainPos,
          ...(timelineLayout && captainSize
            ? {
                style: {
                  width: captainSize.width,
                  height: captainSize.height,
                },
              }
            : {}),
          data: {
            variant: "captain",
            status: captainStatus,
            label: "",
            preview: finalAnswer ? headText(finalAnswer.content) : "",
            handleDirection,
            enterIndex: workerRuns.length + 1,
            hoverDimmed: hoverDimmed(captainRun.id),
            focused: !!finalAnswer && litEndpointMessageId === finalAnswer.id,
            onActivate: finalAnswer
              ? () => activateNode(captainRun.id)
              : undefined,
          },
        } as Node);
      }
    }
  }

  return nodes;
}

/** Pure projection: layout edges + execution status → React Flow edges. */
export function projectFlowEdges({
  edges,
  execution,
  positions,
  handleDirection,
  hoveredNodeId,
  captainRun,
  captainStatus,
}: Pick<
  FlowEdgeProjectionInput,
  | "edges"
  | "execution"
  | "positions"
  | "handleDirection"
  | "hoveredNodeId"
  | "captainRun"
  | "captainStatus"
>): Edge[] {
  const horizontal = handleDirection === "horizontal";
  const ports = computeEdgePorts(edges, positions, horizontal);

  return edges.map((e) => {
    const animated =
      e.target === captainRun?.id
        ? captainStatus === "running"
        : execution.runs.find((s) => s.id === e.target)?.status === "running";
    const kind = e.kind ?? "dep";
    const handoff =
      kind === "dep"
        ? resolveHandoff(execution, e.source, e.target)
        : null;
    const port = ports.get(e.id);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "step",
      animated,
      data: {
        animated,
        kind,
        handoff,
        handleDirection,
        hoveredNodeId: hoveredNodeId ?? null,
        sourcePortIndex: port?.sourcePortIndex ?? 0,
        sourcePortTotal: port?.sourcePortTotal ?? 1,
        targetPortIndex: port?.targetPortIndex ?? 0,
        targetPortTotal: port?.targetPortTotal ?? 1,
      },
    } as Edge;
  });
}
