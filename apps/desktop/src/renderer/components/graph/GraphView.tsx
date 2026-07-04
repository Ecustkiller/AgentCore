import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  hasParallelTimeline,
  parallelTimelineMetricsSummary,
} from "@/components/chat/ParallelTimeline";
import {
  isTimelineLayout,
  resolveEffectiveGraphLayout,
} from "@/lib/graph-layout-utils";
import {
  type RunStatus,
  useActiveExecField,
  useExecutionScope,
  useProjectedExecution,
} from "@/stores/execution";
import { useGraphStore } from "@/stores/graph";
import { type EndpointKind } from "@/stores/sidePanel";
import { useUsageStore } from "@/stores/usage";
import { Background, type Node, ReactFlow } from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";
import { CanvasPlaybackControls } from "./CanvasPlaybackControls";
import { CanvasZoomControls } from "./CanvasZoomControls";
import { GraphContextMenu } from "./GraphContextMenu";
import { GraphToolbar } from "./GraphToolbar";
import { TimeBatchMarkers } from "./TimeBatchMarkers";
import { WaveLanes } from "./WaveLanes";
import { edgeTypes, nodeTypes } from "./constants";
import { type WaveBand, computeWaves, deriveCaptainStatus } from "./helpers";
import { projectFlowEdges, projectFlowNodes } from "./projectFlowGraph";
import { useGraphDrillIn } from "./useGraphDrillIn";
import { useGraphLayout } from "./useGraphLayout";
import { useGraphViewport } from "./useGraphViewport";

interface GraphViewProps {
  embedded?: boolean;
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
  embedded = false,
  onNodeSelect,
  onEndpointSelect,
  onMeasure,
  onClose,
  autoplay = false,
}: GraphViewProps = {}) {
  const messageId = useExecutionScope();
  const execution = useProjectedExecution();
  const hasFrames = useActiveExecField((rt) => rt.frames.length > 0);
  const layoutKind = useGraphStore((s) => s.layoutKind);
  const setLayoutKind = useGraphStore((s) => s.setLayoutKind);
  const parallelAvailable = !!execution && hasParallelTimeline(execution);
  const effectiveLayoutKind = resolveEffectiveGraphLayout(layoutKind, {
    embedded,
    parallelAvailable,
  });
  const timelineLayout = isTimelineLayout(effectiveLayoutKind);
  const {
    positions,
    edges,
    bbox,
    layoutReady,
    nodeHeights,
    nodeSizes,
    batchDividers,
    onNodesChange,
  } = useGraphLayout(execution, effectiveLayoutKind);
  const { containerRef, rfRef, overflowing, fitView, centerNode, onInit } =
    useGraphViewport({ embedded, bbox, layoutReady, onMeasure });
  const handleDirection =
    effectiveLayoutKind === "leftright" || timelineLayout
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
    embedded,
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

  const onNodeMouseEnter = useCallback(
    (_event: React.MouseEvent, node: Node) => setHoveredNodeId(node.id),
    [],
  );

  const onNodeMouseLeave = useCallback(() => setHoveredNodeId(null), []);

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

  const projectionBase = useMemo(
    () =>
      execution
        ? {
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
            edges,
          }
        : null,
    [
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
      edges,
    ],
  );

  const flowNodes = useMemo(
    () => (projectionBase ? projectFlowNodes(projectionBase) : []),
    [projectionBase],
  );

  const flowEdges = useMemo(
    () =>
      projectionBase
        ? projectFlowEdges({ ...projectionBase, edges })
        : [],
    [projectionBase, edges],
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

  const interactionProps = embedded
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
                fitView={!embedded}
                nodesDraggable={false}
                nodesConnectable={false}
                nodesFocusable={false}
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
                {...interactionProps}
              >
                <Background gap={20} size={1} />
                <WaveLanes waves={waves} />
                {timelineLayout && bbox && (
                  <TimeBatchMarkers
                    dividers={batchDividers}
                    height={bbox.height}
                  />
                )}
              </ReactFlow>
            )}

            {embedded && overflowing && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
            )}

            {!embedded && (
              <GraphToolbar
                layoutKind={layoutKind}
                onLayoutKindChange={setLayoutKind}
                metricsSummary={metricsSummary}
                timelineAvailable={parallelAvailable}
              />
            )}

            {!embedded && (
              <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-2">
                {hasFrames && !timelineLayout && (
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
