import {
  hasParallelTimeline,
  parallelTimelineMetricsSummary,
} from "@/components/chat/ParallelTimeline";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useTurnAudit } from "@/hooks/useTurnAudit";
import { buildInjectGraphOverlay } from "@/lib/causalInject";
import { resolveEffectiveGraphLayout } from "@/lib/graph-layout-utils";
import { groupAuditCountsByRun } from "@/services/audit";
import { useConversationStore } from "@/stores/conversation";
import {
  type RunStatus,
  useActiveExecField,
  useExecutionScope,
  useProjectedExecution,
} from "@/stores/execution";
import { useGraphStore } from "@/stores/graph";
import type { EndpointKind } from "@/stores/sidePanel";
import { useUsageStore } from "@/stores/usage";
import { Background, ReactFlow, type Node } from "@xyflow/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { CanvasPlaybackControls } from "./CanvasPlaybackControls";
import { CanvasZoomControls } from "./CanvasZoomControls";
import { GraphContextMenu } from "./GraphContextMenu";
import { GraphToolbar } from "./GraphToolbar";
import { WaveLanes } from "./WaveLanes";
import { edgeTypes, nodeTypes } from "./constants";
import {
  GraphHoverContext,
  computeKeepBrightIds,
  hoverRelatedIds,
} from "./graphHover";
import { type WaveBand, computeWaves, deriveCaptainStatus } from "./helpers";
import { projectFlowEdges, projectFlowNodes } from "./projectFlowGraph";
import { useGraphDrillIn } from "./useGraphDrillIn";
import { useGraphLayout } from "./useGraphLayout";
import { type GraphFitMode, useGraphViewport } from "./useGraphViewport";

export type { GraphHoverState } from "./graphHover";
export { GraphHoverContext };

interface GraphViewProps {
  interactive?: boolean;
  fitMode?: GraphFitMode;
  onNodeSelect?: (runId: string) => void;
  onEndpointSelect?: (
    contentMessageId: string,
    title: string,
    endpoint: EndpointKind,
  ) => void;
  onMeasure?: (m: { height: number; overflowing: boolean }) => void;
  onClose?: () => void;
  autoplay?: boolean;
}

export function GraphView({
  interactive = true,
  fitMode = "view",
  onNodeSelect,
  onEndpointSelect,
  onMeasure,
  onClose,
  autoplay = false,
}: GraphViewProps = {}) {
  const messageId = useExecutionScope();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const execution = useProjectedExecution();
  const isMultiAgent = execution?.planType === "multi_agent";
  const { data: turnAudit } = useTurnAudit(
    isMultiAgent ? conversationId : null,
    isMultiAgent ? messageId : null,
  );
  const auditCounts = useMemo(
    () => (turnAudit ? groupAuditCountsByRun(turnAudit.data) : {}),
    [turnAudit],
  );
  const showAuditInjectFlow = useGraphStore((s) => s.showAuditInjectFlow);
  const setShowAuditInjectFlow = useGraphStore((s) => s.setShowAuditInjectFlow);
  const hasFrames = useActiveExecField((rt) => rt.frames.length > 0);
  const layoutKind = useGraphStore((s) => s.layoutKind);
  const setLayoutKind = useGraphStore((s) => s.setLayoutKind);
  const parallelAvailable = !!execution && hasParallelTimeline(execution);
  const effectiveLayoutKind = resolveEffectiveGraphLayout(layoutKind);
  const [expandedUnits, setExpandedUnits] = useState<Set<string>>(
    () => new Set(),
  );
  const onToggleUnitExpand = useCallback((unitId: string) => {
    setExpandedUnits((prev) => {
      const next = new Set(prev);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      return next;
    });
  }, []);
  const {
    positions,
    edges,
    bbox,
    layoutReady,
    nodeHeights,
    nodeSizes,
    onNodesChange,
    groups,
    subTeams,
    foldInfo,
  } = useGraphLayout(execution, effectiveLayoutKind, fitMode, expandedUnits);
  const { containerRef, rfRef, overflowing, fitView, centerNode, onInit } =
    useGraphViewport({ fitMode, bbox, layoutReady, onMeasure });
  const handleDirection =
    effectiveLayoutKind === "leftright"
      ? ("horizontal" as const)
      : ("vertical" as const);
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);

  const {
    activateNode,
    showRunDetailHere,
    litRunId,
    litEndpointMessageId,
    finalAnswer,
    taskMessage,
    captainRun,
  } = useGraphDrillIn(execution, {
    interactive,
    messageId,
    onNodeSelect,
    onEndpointSelect,
    onClose,
  });

  const [menuNodeId, setMenuNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const metricsSummary = useMemo(
    () =>
      parallelAvailable && execution
        ? parallelTimelineMetricsSummary(execution)
        : null,
    [parallelAvailable, execution],
  );

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

  const hoverClearRef = useRef<number | null>(null);

  const onNodeMouseEnter = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (hoverClearRef.current != null) {
        cancelAnimationFrame(hoverClearRef.current);
        hoverClearRef.current = null;
      }
      setHoveredNodeId(node.id);
    },
    [],
  );

  const onNodeMouseLeave = useCallback(() => {
    hoverClearRef.current = requestAnimationFrame(() => {
      setHoveredNodeId(null);
      hoverClearRef.current = null;
    });
  }, []);

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      setMenuNodeId(null);
    },
    [],
  );

  const captainStatus = useMemo<RunStatus | null>(
    () =>
      execution && captainRun
        ? deriveCaptainStatus(execution, captainRun.id)
        : null,
    [execution, captainRun],
  );

  const injectOverlay = useMemo(
    () =>
      isMultiAgent
        ? buildInjectGraphOverlay(turnAudit?.causal_graph, edges, {
            focusRunId: litRunId,
            showAllInject: showAuditInjectFlow,
          })
        : null,
    [
      isMultiAgent,
      turnAudit?.causal_graph,
      edges,
      litRunId,
      showAuditInjectFlow,
    ],
  );

  const injectFlowAvailable = useMemo(
    () =>
      isMultiAgent &&
      (turnAudit?.causal_graph?.edges?.some((e) => e.kind === "inject") ??
        false),
    [isMultiAgent, turnAudit?.causal_graph],
  );

  const projectionBase = useMemo(
    () =>
      execution
        ? {
            execution,
            positions,
            nodeHeights,
            nodeSizes,
            handleDirection,
            cnyPerUsd,
            litRunId,
            litEndpointMessageId,
            captainRun,
            captainStatus,
            finalAnswer,
            taskMessage,
            activateNode,
            groups,
            subTeams,
            auditCounts,
            foldInfo: foldInfo ?? undefined,
            expandedUnits,
            onToggleUnitExpand,
          }
        : null,
    [
      execution,
      positions,
      nodeHeights,
      nodeSizes,
      handleDirection,
      cnyPerUsd,
      litRunId,
      litEndpointMessageId,
      captainRun,
      captainStatus,
      finalAnswer,
      taskMessage,
      activateNode,
      groups,
      subTeams,
      auditCounts,
      foldInfo,
      expandedUnits,
      onToggleUnitExpand,
    ],
  );

  const flowNodes = useMemo(
    () => (projectionBase ? projectFlowNodes(projectionBase) : []),
    [projectionBase],
  );

  const hoverState = useMemo(() => {
    const injectRelated = injectOverlay?.dimUnrelatedEdges
      ? injectOverlay.relatedNodeIds
      : null;
    const hoverRelated = hoveredNodeId
      ? hoverRelatedIds(hoveredNodeId, edges)
      : null;
    return {
      hoveredNodeId,
      keepBrightIds: computeKeepBrightIds(hoverRelated, injectRelated),
    };
  }, [hoveredNodeId, edges, injectOverlay]);

  const flowEdges = useMemo(
    () =>
      projectionBase
        ? projectFlowEdges({ ...projectionBase, edges, injectOverlay })
        : [],
    [projectionBase, edges, injectOverlay],
  );

  const waves = useMemo<WaveBand[]>(
    () =>
      execution && bbox
        ? computeWaves(
            execution,
            positions,
            bbox,
            effectiveLayoutKind,
            captainRun?.id ?? null,
          )
        : [],
    [execution, positions, bbox, effectiveLayoutKind, captainRun],
  );

  const interactionProps = !interactive
    ? {
        zoomOnScroll: false,
        zoomOnPinch: false,
        zoomOnDoubleClick: false,
        panOnDrag: false,
        preventScrolling: false,
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
    <div className="flex h-full w-full flex-col">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={containerRef} className="relative min-h-0 flex-1">
            {layoutReady && (
              <GraphHoverContext.Provider value={hoverState}>
                <ReactFlow
                  nodes={flowNodes}
                  edges={flowEdges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onInit={onInit}
                  onNodesChange={onNodesChange}
                  onNodeClick={onNodeClick}
                  onNodeMouseEnter={onNodeMouseEnter}
                  onNodeMouseLeave={onNodeMouseLeave}
                  onNodeContextMenu={onNodeContextMenu}
                  onPaneContextMenu={onPaneContextMenu}
                  fitView={fitMode === "view"}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  nodesFocusable={false}
                  elementsSelectable={false}
                  proOptions={{ hideAttribution: true }}
                  {...interactionProps}
                >
                  <Background gap={20} size={1} />
                  <WaveLanes waves={waves} />
                </ReactFlow>
              </GraphHoverContext.Provider>
            )}

            {fitMode === "width" && overflowing && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
            )}

            {interactive && (
              <GraphToolbar
                layoutKind={layoutKind}
                onLayoutKindChange={setLayoutKind}
                metricsSummary={metricsSummary}
                injectFlowAvailable={injectFlowAvailable}
                showAuditInjectFlow={showAuditInjectFlow}
                onShowAuditInjectFlowChange={setShowAuditInjectFlow}
              />
            )}

            {interactive &&
              injectOverlay &&
              (showAuditInjectFlow || injectOverlay.gapEdges.length > 0) && (
                <div className="pointer-events-none absolute bottom-3 right-3 z-10 rounded-lg border border-border bg-card/90 px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur">
                  <span className="text-foreground">──</span> 计划依赖
                  <span className="mx-2 text-muted-foreground/50">·</span>
                  <span className="text-primary">⇢</span> 数据注入（审计）
                </div>
              )}

            {interactive && (
              <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-2">
                {hasFrames && (
                  <CanvasPlaybackControls autoPlay={autoplay} />
                )}
                <CanvasZoomControls
                  onZoomIn={() => rfRef.current?.zoomIn({ duration: 200 })}
                  onZoomOut={() => rfRef.current?.zoomOut({ duration: 200 })}
                  onFit={fitView}
                  fitLabel="适应画布 (F)"
                />
              </div>
            )}
          </div>
        </ContextMenuTrigger>

        <GraphContextMenu
          menuNodeId={menuNodeId}
          captainRunId={captainRun?.id}
          taskMessage={taskMessage}
          finalAnswer={finalAnswer}
          onNodeSelect={onNodeSelect}
          showRunDetailHere={showRunDetailHere}
          onClose={onClose}
          activateNode={activateNode}
          centerNode={centerNode}
          fitView={fitView}
        />
      </ContextMenu>
    </div>
  );
}
