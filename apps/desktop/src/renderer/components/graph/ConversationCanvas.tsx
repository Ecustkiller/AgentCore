import { useBackgroundTasksSync } from "@/stores/backgroundTasks";
import { useCommandPanelStore } from "@/stores/commandPanel";
import {
  useActiveGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { useSidePanelStore } from "@/stores/sidePanel";
import { Background, Panel, ReactFlow } from "@xyflow/react";
import { ArrowUp, Loader2, Network } from "lucide-react";
import { useEffect, useState } from "react";
import { CanvasCommandBar } from "./CanvasCommandBar";
import { CanvasTurnRail } from "./CanvasTurnRail";
import { CanvasZoomControls } from "./CanvasZoomControls";
import { CanvasZoomedTurn } from "./CanvasZoomedTurn";
import { FocusedTurnNode } from "./FocusedTurnNode";
import { SimpleTurnNode } from "./SimpleTurnNode";
import { TurnSummaryNode } from "./TurnSummaryNode";
import {
  useCanvasFocus,
  useCanvasFocusState,
  useCanvasNodeHandlers,
} from "./useCanvasFocus";
import { useCanvasTurns } from "./useCanvasTurns";
import { useCanvasZoom } from "./useCanvasZoom";

/**
 * 对话级画布（前端UX设计.md §6.1 · 持久累积 + LOD）. The opt-in second
 * view {@link import("../../pages/ConversationPage")} renders in place of {@link
 * import("../chat/ChatView")} when the conversation's view mode is "canvas" (画布
 * 已毕业，无实验开关——入口恒显示、对话页默认聊天，前端UX设计.md §六）。
 *
 * 乙-1 单张持久画布: ONE pannable surface where every turn accumulates as a node, top
 * → bottom (视觉累积), with a tokenized zoom/fit cluster (no minimap — a vertical spine's
 * minimap is low-value clutter). Identity continuity (「同一拨人」) rides on `agentIdentity`
 * — same role ⇒ same avatar across turns — WITHOUT backend worker实体化 (= 乙-2, 否, 见设计 §八).
 *
 * LOD「只有聚焦回合画完整 DAG」(§七 节点 ≤50 / ≥60fps): exactly ONE team turn is
 * focused (default latest, auto-follows new turns, click a summary to switch). The
 * focused turn expands IN PLACE to its full worker DAG ({@link FocusedTurnNode},
 * embedded GraphView); every other team turn folds to a {@link TurnSummaryNode}
 * (回合摘要节点), and a single-agent turn degenerates to a {@link SimpleTurnNode}
 * (竖排轻卡). So the canvas draws one full DAG + O(turns) summary nodes, never a wall
 * of nodes. The 全屏 button on the focused node hands off to the on-demand overlay.
 *
 * Single data source (设计 §二「一份数据两种渲染」): every node projects from the same
 * `projectExecution` fold the chat view reads. Reloaded team turns are hydrated from
 * their journal here (the chat view's InlineTeamGraph isn't mounted in canvas mode),
 * idempotently. The bottom {@link CanvasCommandBar} is always present (常驻底栏).
 */

const turnNodeTypes = {
  focusedTurn: FocusedTurnNode,
  teamTurn: TurnSummaryNode,
  simpleTurn: SimpleTurnNode,
};

export function ConversationCanvas() {
  const generating = useActiveGenerating();

  const { focusedTurn, setFocusedTurn } = useCanvasFocusState();
  const {
    zoomedTurn,
    zoomAutoplay,
    zoomView,
    zoomComparePair,
    zoomShown,
    openZoom,
    exitZoom,
    onZoomOverlayTransitionEnd,
    overviewScaleClass,
  } = useCanvasZoom(setFocusedTurn);

  const { turns, effectiveFocus, railItems, nodes, edges } = useCanvasTurns({
    focusedTurn,
    setFocusedTurn,
    openZoom,
  });

  const {
    rfRef,
    canvasBoxRef,
    hasMoreBefore,
    loadingOlder,
    requestOlder,
    onMove,
    onInit,
  } = useCanvasFocus({ turns, effectiveFocus, nodes });

  const { onNodeClick, onNodeDoubleClick, makeOnRailSelect } =
    useCanvasNodeHandlers(setFocusedTurn, openZoom);
  const onRailSelect = makeOnRailSelect(rfRef);

  const conversationId = useConversationStore((s) => s.currentConversationId);

  // 图上指挥 (§6.2): the 指挥台 now lives in the unified side panel ({@link
  // import("./CanvasDecisionPanel").CommandRegion}), not a second dock here. Turn focus
  // is a canvas concept, so publish「canvas active」+ the focused team turn to the bridge
  // store; the region derives the rest live and self-surfaces. Keep driving the 后台云端
  // 任务 poll — the region only reads it, and it must tick even while collapsed / closed.
  useBackgroundTasksSync(conversationId);
  useEffect(() => {
    const cmd = useCommandPanelStore.getState();
    cmd.setActive(true);
    return () => cmd.setActive(false);
  }, []);
  useEffect(() => {
    useCommandPanelStore.getState().setFocused(effectiveFocus);
  }, [effectiveFocus]);

  const [dispatched, setDispatched] = useState(false);
  useEffect(() => {
    if (!generating) setDispatched(false);
  }, [generating]);

  useEffect(() => () => useSidePanelStore.getState().closeContentTabs(), []);

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border pl-40 pr-12">
        <span className="truncate text-sm font-medium text-foreground">
          画布
        </span>
        {turns.length > 0 && (
          <span className="ml-2 shrink-0 text-xs text-muted-foreground">
            {turns.length} 回合
          </span>
        )}
      </div>
      <div
        ref={canvasBoxRef}
        className={`relative min-h-0 flex-1 origin-center transition-transform duration-200 ease-out motion-reduce:transition-none ${overviewScaleClass}`}
      >
        {turns.length > 0 ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={turnNodeTypes}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onMove={onMove}
            onInit={onInit}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnDoubleClick={false}
            minZoom={0.2}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            {hasMoreBefore && (
              <Panel position="top-center">
                <button
                  type="button"
                  onClick={requestOlder}
                  disabled={loadingOlder}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
                >
                  {loadingOlder ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      载入更早…
                    </>
                  ) : (
                    <>
                      <ArrowUp size={12} />
                      更早
                    </>
                  )}
                </button>
              </Panel>
            )}
            <Panel position="bottom-left">
              <CanvasZoomControls
                onZoomIn={() => rfRef.current?.zoomIn({ duration: 200 })}
                onZoomOut={() => rfRef.current?.zoomOut({ duration: 200 })}
                onFit={() =>
                  rfRef.current?.fitView({
                    padding: 0.2,
                    maxZoom: 1,
                    duration: 300,
                  })
                }
              />
            </Panel>
          </ReactFlow>
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-sm text-center">
              <Network
                size={28}
                className="mx-auto mb-3 text-muted-foreground"
              />
              <p className="text-sm text-muted-foreground">
                还没有回合。在下方下达一个需要多 Agent 协作的任务，CEO
                组好队后这里就会展开画布。
              </p>
            </div>
          </div>
        )}
        <CanvasTurnRail
          items={railItems}
          focusedId={effectiveFocus}
          onSelect={onRailSelect}
        />
      </div>
      <CanvasCommandBar
        onDispatch={() => setDispatched(true)}
        waiting={dispatched && generating}
        allowBackground
      />
      {zoomedTurn && (
        <div
          className={`absolute inset-0 z-20 origin-center transition duration-200 ease-out motion-reduce:transition-none ${
            zoomShown ? "scale-100 opacity-100" : "scale-[0.92] opacity-0"
          }`}
          onTransitionEnd={onZoomOverlayTransitionEnd}
        >
          <CanvasZoomedTurn
            key={zoomedTurn}
            turnId={zoomedTurn}
            autoplay={zoomAutoplay}
            initialView={zoomView}
            initialComparePair={zoomComparePair}
            onClose={exitZoom}
          />
        </div>
      )}
    </div>
  );
}
