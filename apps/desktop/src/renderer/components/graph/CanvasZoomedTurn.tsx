import { TurnCompare } from "@/components/chat/compare/TurnCompare";
import { DebateStream } from "@/components/chat/debate/DebateStream";
import { toDebateModel } from "@/components/chat/debate/model";
import { Button } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  type CanvasTurnView,
  loadCanvasTurnView,
  persistCanvasTurnView,
  resolveCanvasTurnView,
} from "@/lib/canvasTurnView";
import {
  applyCanvasZoomPanelPref,
  captureCanvasZoomPanelPref,
  defaultCanvasZoomPanelPref,
  loadCanvasZoomPanelPref,
  persistCanvasZoomPanelPref,
} from "@/lib/canvasZoomPanel";
import {
  useActiveGenerating,
  useActiveMessages,
  useConversationStore,
} from "@/stores/conversation";
import { useDebateRoomStore } from "@/stores/debateRoom";
import {
  ExecutionScopeContext,
  hasRevisions,
  isDebate,
  useMessageExecution,
} from "@/stores/execution";
import { type EndpointKind, useSidePanelStore } from "@/stores/sidePanel";
import type { CanvasFocusView } from "@/stores/ui";
import {
  ArrowLeft,
  GitCompare,
  MessagesSquare,
  Network,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CanvasCommandBar } from "./CanvasCommandBar";
import { GraphView } from "./GraphView";

/** 放大态可切换的视图：群聊 (辩论室) / 对比 (非辩论修订链·可选) / 协作图 (含底栏真实时间轴甘特)。 */
type TurnView = CanvasTurnView;

/** 辩论 → 群聊（协作图改由头部按钮唤出浮层）；其余 → 协作图。 */
function naturalTurnView(debate: boolean): TurnView {
  return debate ? "room" : "graph";
}

/**
 * The canvas's 放大态 (前端UX设计.md §六 · Route A): one turn's full collaboration
 * DAG taking over the canvas surface, with zoom/pan + layout toolbar + replay
 * timeline. It replaces the old portal-to-body full-screen overlay — instead of a
 * second, parallel "全屏" concept, this is simply the canvas zoomed into a single
 * turn, rendered IN PLACE inside {@link import("./ConversationCanvas")} (no portal,
 * no global graph state). The overview ⇄ 放大 swap keeps exactly one interactive
 * ReactFlow mounted at a time, so the inner DAG owns pan/zoom here while the
 * overview owns it there — no nested-zoom conflict
 *
 * Drill-ins: both a worker node AND an endpoint (用户输入 / CEO 汇聚点) hand off to
 * the conversation's shared right-docked {@link import("@/components/layout/SidePanel")}
 * — a worker as a run-detail tab, an endpoint as a content tab (提问 / 最终回答) — so
 * detail always opens to the right and the lit node survives leaving zoom. Per-conversation
 * panel preference is persisted (`canvasZoomPanel`) so re-entering zoom restores the last
 * surface (or defaults to 最终回答 / closed — never 工作区). The bottom
 * {@link CanvasCommandBar} dispatches the next order and this view follows the new
 * round in place. Esc steps back progressively: close the side panel → exit to the
 * overview; 返回 exits too. `autoplay` starts the replay timeline — the inline card's
 * 回放 entry — but only on the turn it opened on, never a follow.
 */
export function CanvasZoomedTurn({
  turnId,
  autoplay = false,
  initialView,
  initialComparePair,
  onClose,
}: {
  turnId: string;
  autoplay?: boolean;
  /** 聊天侧信号深链的初始视图（如「对比」）；缺省走该回合自然默认（辩论=群聊 / 其余=协作图）。 */
  initialView?: CanvasFocusView;
  /** 深链「对比」时预选的 A/B 版本对（run.id）；透传给 {@link TurnCompare} 作初始 pair。 */
  initialComparePair?: [string, string];
  onClose: () => void;
}) {
  const [scopeId, setScopeId] = useState(turnId);
  const execution = useMessageExecution(scopeId);
  const taskSummary = execution?.taskSummary;
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const showContentDetail = useSidePanelStore((s) => s.showContentDetail);
  const messages = useActiveMessages();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const interactive =
    messages.find((m) => m.id === scopeId)?.isStreaming ?? false;

  const debate = !!execution && isDebate(execution);
  const twoSideDebate =
    debate && execution ? toDebateModel(execution)?.form === "debate" : false;
  const revisable = !!execution && hasRevisions(execution);
  const showCompareTab = revisable && !debate;
  const pendingInitialView = useRef<TurnView | null>(
    initialView === "compare" && !twoSideDebate ? "compare" : null,
  );
  const initialParallelRef = useRef<boolean>(
    initialView === "compare" && twoSideDebate,
  );
  const [view, setView] = useState<TurnView>(() => {
    if (pendingInitialView.current) return pendingInitialView.current;
    const natural = naturalTurnView(debate);
    if (!conversationId) return natural;
    const avail = debate
      ? new Set<TurnView>(["room"])
      : new Set<TurnView>([natural, "graph"]);
    return resolveCanvasTurnView(
      loadCanvasTurnView(conversationId, scopeId),
      natural,
      avail,
    );
  });

  const viewTabs = useMemo(() => {
    const tabs: { id: TurnView; label: string; icon: ReactNode }[] = [];
    if (debate) {
      tabs.push({
        id: "room",
        label: "群聊",
        icon: <MessagesSquare size={14} />,
      });
    } else {
      if (showCompareTab)
        tabs.push({
          id: "compare",
          label: "对比",
          icon: <GitCompare size={14} />,
        });
      tabs.push({ id: "graph", label: "协作图", icon: <Network size={14} /> });
    }
    return tabs;
  }, [debate, showCompareTab]);

  const availableViews = useMemo(
    () => new Set(viewTabs.map((t) => t.id)),
    [viewTabs],
  );

  useEffect(() => {
    if (pendingInitialView.current && scopeId === turnId) return;
    const natural = naturalTurnView(debate);
    if (!conversationId) {
      setView(natural);
      return;
    }
    setView(
      resolveCanvasTurnView(
        loadCanvasTurnView(conversationId, scopeId),
        natural,
        availableViews,
      ),
    );
  }, [debate, scopeId, turnId, conversationId, availableViews]);

  const selectView = useCallback(
    (v: TurnView) => {
      setView(v);
      pendingInitialView.current = null;
      if (conversationId) persistCanvasTurnView(conversationId, scopeId, v);
    },
    [conversationId, scopeId],
  );

  const [graphOverlay, setGraphOverlay] = useState(false);
  const [graphOverlayAutoplay, setGraphOverlayAutoplay] = useState(false);
  const didAutoGraph = useRef(false);
  useEffect(() => {
    if (didAutoGraph.current) return;
    if (debate && autoplay && scopeId === turnId) {
      didAutoGraph.current = true;
      setGraphOverlay(true);
      setGraphOverlayAutoplay(true);
    }
  }, [debate, autoplay, scopeId, turnId]);
  const openGraphOverlay = useCallback(() => {
    setGraphOverlayAutoplay(false);
    setGraphOverlay(true);
  }, []);
  const closeGraphOverlay = useCallback(() => setGraphOverlay(false), []);

  const showRoom = debate && view === "room";
  const showCompare = showCompareTab && view === "compare";

  const finalAnswerId = useMemo(() => {
    if (!execution) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.executionId === execution.id) {
        return m.content ? m.id : null;
      }
    }
    return null;
  }, [messages, execution]);

  const onNodeSelect = useCallback(
    (runId: string) => {
      const run = execution?.runs.find((r) => r.id === runId);
      const role = execution?.agents.find((a) => a.id === run?.agentId)?.role;
      showRunDetail(scopeId, runId, role);
    },
    [execution, scopeId, showRunDetail],
  );

  const onEndpointSelect = useCallback(
    (contentMessageId: string, title: string, endpoint: EndpointKind) =>
      showContentDetail(scopeId, contentMessageId, title, endpoint),
    [scopeId, showContentDetail],
  );

  const panelRestored = useRef(false);
  useEffect(() => {
    panelRestored.current = false;
  }, [conversationId, turnId]);

  useEffect(() => {
    if (!conversationId || panelRestored.current) return;

    const saved = loadCanvasZoomPanelPref(conversationId);
    if (saved) {
      applyCanvasZoomPanelPref(saved);
      panelRestored.current = true;
      return;
    }

    if (showRoom) {
      applyCanvasZoomPanelPref(
        defaultCanvasZoomPanelPref({
          showRoom: true,
          scopeId,
          finalAnswerId,
        }),
      );
      panelRestored.current = true;
      return;
    }

    if (finalAnswerId) {
      applyCanvasZoomPanelPref(
        defaultCanvasZoomPanelPref({
          showRoom: false,
          scopeId,
          finalAnswerId,
        }),
      );
      panelRestored.current = true;
      return;
    }

    if (!execution) return;

    applyCanvasZoomPanelPref(
      defaultCanvasZoomPanelPref({
        showRoom: false,
        scopeId,
        finalAnswerId: null,
      }),
    );
    panelRestored.current = true;
  }, [conversationId, showRoom, scopeId, finalAnswerId, execution]);

  useEffect(() => {
    if (!conversationId) return;
    const persistNow = () =>
      persistCanvasZoomPanelPref(
        conversationId,
        captureCanvasZoomPanelPref(),
      );
    const unsub = useSidePanelStore.subscribe(persistNow);
    return () => {
      unsub();
      persistNow();
    };
  }, [conversationId]);

  const generating = useActiveGenerating();
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    if (!following) return;
    let last: (typeof messages)[number] | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        last = messages[i];
        break;
      }
    }
    if (!last || last.id === scopeId) return;
    if (last.executionId) {
      setScopeId(last.id);
      setFollowing(false);
    } else if (!last.isStreaming && !generating) {
      setFollowing(false);
      onClose();
    }
  }, [following, messages, generating, scopeId, onClose]);

  useEffect(() => {
    if (showRoom && execution) {
      useDebateRoomStore
        .getState()
        .setTarget({ turnId: scopeId, conversationId, interactive });
    } else {
      useDebateRoomStore.getState().setTarget(null);
    }
    return () => useDebateRoomStore.getState().setTarget(null);
  }, [showRoom, execution, scopeId, conversationId, interactive]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const sp = useSidePanelStore.getState();
      const panelVisible =
        sp.open &&
        sp.tabs.some((t) => t.id === sp.activeTabId && t.messageId === scopeId);
      if (panelVisible) sp.closePanel();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, scopeId]);

  return (
    <ExecutionScopeContext.Provider value={scopeId}>
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <Button
            variant="neutral"
            size="md"
            onClick={onClose}
            icon={<ArrowLeft size={16} />}
          >
            返回
          </Button>
          {taskSummary && (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {taskSummary}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {debate && (
              <SimpleTooltip label="查看这场辩论的协作图（谁干了啥 · 真实时间轴 · 花多少）——群聊之上叠一层，关掉即回">
                <Button
                  variant="ghost"
                  onClick={openGraphOverlay}
                  aria-pressed={graphOverlay}
                  icon={<Network size={14} />}
                  className={
                    graphOverlay
                      ? "bg-accent text-foreground hover:bg-accent"
                      : undefined
                  }
                >
                  协作图
                </Button>
              </SimpleTooltip>
            )}
            {viewTabs.length >= 2 && (
              <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
                {viewTabs.map((v) => (
                  <Button
                    key={v.id}
                    variant="ghost"
                    onClick={() => selectView(v.id)}
                    aria-pressed={view === v.id}
                    icon={v.icon}
                    className={
                      view === v.id
                        ? "bg-accent text-foreground hover:bg-accent"
                        : undefined
                    }
                  >
                    {v.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {showRoom && execution ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <DebateStream
                execution={execution}
                messageId={scopeId}
                initialParallel={initialParallelRef.current}
                readingWidth="canvas"
              />
            </div>
          ) : showCompare && execution ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mx-auto max-w-5xl">
                <TurnCompare
                  execution={execution}
                  messageId={scopeId}
                  initialPair={initialComparePair}
                />
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <GraphView
                key={scopeId}
                autoplay={autoplay && scopeId === turnId}
                onClose={onClose}
                onNodeSelect={onNodeSelect}
                onEndpointSelect={onEndpointSelect}
              />
            </div>
          )}
          {graphOverlay && debate && execution && (
            <div className="absolute inset-0 z-20 flex flex-col bg-background">
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
                <Button
                  variant="neutral"
                  size="sm"
                  onClick={closeGraphOverlay}
                  icon={<ArrowLeft size={15} />}
                >
                  返回辩论室
                </Button>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  协作图 · 这场辩论怎么跑的（依赖结构 · 真实时间轴 · 花多少）
                </span>
              </div>
              <div className="min-h-0 flex-1">
                <GraphView
                  key={`graph-overlay-${scopeId}`}
                  autoplay={graphOverlayAutoplay}
                  onClose={closeGraphOverlay}
                  onNodeSelect={onNodeSelect}
                  onEndpointSelect={onEndpointSelect}
                />
              </div>
            </div>
          )}
        </div>

        <CanvasCommandBar
          onDispatch={() => setFollowing(true)}
          waiting={following && generating}
        />
      </div>
    </ExecutionScopeContext.Provider>
  );
}
