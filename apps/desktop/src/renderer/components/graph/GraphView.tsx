import { computeLayout } from "@/lib/elk-layout";
import { estimateTokens, tailText } from "@/lib/format";
import { useExecutionStore, useProjectedExecution } from "@/stores/execution";
import { type GraphEdge, useGraphStore } from "@/stores/graph";
import {
  Background,
  Controls,
  type Edge,
  type Node,
  ReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentNode } from "./AgentNode";
import { NodeDetail } from "./NodeDetail";
import { StepEdge } from "./StepEdge";
import { Timeline } from "./Timeline";

const nodeTypes = { agent: AgentNode };
const edgeTypes = { step: StepEdge };

export function GraphView() {
  const execution = useProjectedExecution();
  const hasFrames = useExecutionStore((s) => s.frames.length > 0);
  const positions = useGraphStore((s) => s.positions);
  const edges = useGraphStore((s) => s.edges);
  const setLayout = useGraphStore((s) => s.setLayout);
  const focusedStepId = useExecutionStore((s) => s.focusedStepId);
  const focusedAgentId = useExecutionStore((s) => s.focusedAgentId);
  const focusStep = useExecutionStore((s) => s.focusStep);
  const [layoutReady, setLayoutReady] = useState(false);

  // Layout depends only on graph *shape* (step ids + dependencies), so it is
  // recomputed when the plan changes — not on every streamed token.
  const structuralKey = useMemo(
    () =>
      execution
        ? execution.steps
            .map((s) => `${s.id}:${s.dependsOn.join(",")}`)
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
    const steps = useExecutionStore.getState().plan?.steps ?? [];
    const nodeIds = steps.map((s) => s.id);
    const rawEdges: GraphEdge[] = steps.flatMap((step) =>
      step.dependsOn.map((depId) => ({
        id: `${depId}->${step.id}`,
        source: depId,
        target: step.id,
      })),
    );

    let cancelled = false;
    computeLayout(nodeIds, rawEdges).then((layouted) => {
      if (cancelled) return;
      setLayout(layouted, rawEdges);
      setLayoutReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [structuralKey, setLayout]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      focusStep(node.id === focusedStepId ? null : node.id);
    },
    [focusStep, focusedStepId],
  );

  const flowNodes = useMemo<Node[]>(() => {
    if (!execution) return [];
    return execution.steps.map((step) => {
      const agent = execution.agents.find((a) => a.id === step.agentId);
      const output = agent ? agent.outputChunks.join("") : "";
      const focused =
        focusedStepId === step.id ||
        (focusedStepId === null && focusedAgentId === step.agentId);
      return {
        id: step.id,
        type: "agent",
        position: positions[step.id] ?? { x: 0, y: 0 },
        data: {
          agentId: step.agentId,
          role: agent?.role ?? step.agentId,
          modelPreference: agent?.modelPreference,
          reasoningEffort: agent?.reasoningEffort,
          stepId: step.id,
          status: step.status,
          isAnimating: step.status === "running",
          outputPreview: tailText(output),
          tokenCount: estimateTokens(output),
          toolCount: agent?.toolCalls.length ?? 0,
          focused,
          checkpoint: step.checkpoint,
        },
      } as Node;
    });
  }, [execution, positions, focusedStepId, focusedAgentId]);

  const flowEdges = useMemo<Edge[]>(() => {
    return edges.map((e) => {
      const target = execution?.steps.find((s) => s.id === e.target);
      const animated = target?.status === "running";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "step",
        animated,
        data: { animated },
      } as Edge;
    });
  }, [edges, execution]);

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
            onNodeClick={onNodeClick}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}

        {hasFrames && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
            <Timeline />
          </div>
        )}
      </div>

      {focusedStepId && (
        <NodeDetail nodeId={focusedStepId} onClose={() => focusStep(null)} />
      )}
    </div>
  );
}
