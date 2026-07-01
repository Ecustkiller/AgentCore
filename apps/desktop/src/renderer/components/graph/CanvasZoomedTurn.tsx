import {
  ParallelTimeline,
  hasParallelTimeline,
} from "@/components/chat/ParallelTimeline";
import { TurnCompare } from "@/components/chat/compare/TurnCompare";
import { DebateStream } from "@/components/chat/debate/DebateStream";
import { toDebateModel } from "@/components/chat/debate/model";
import { Button } from "@/components/ui";
import {
  type CanvasTurnView,
  loadCanvasTurnView,
  persistCanvasTurnView,
  resolveCanvasTurnView,
} from "@/lib/canvasTurnView";
import {
  useActiveGenerating,
  useActiveMessages,
  useConversationStore,
} from "@/stores/conversation";
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
  Clock,
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

/** 放大态可切换的视图：群聊 (辩论室·统一 IM 主视图) / 对比 (辩论逐轮擂台 ∪ 定向唤回版本链·统一
 *  对比透镜·可选) / 协作图 (依赖结构) / 并行时间线 (时间真相)。 */
type TurnView = CanvasTurnView;

/** 辩论默认群聊；回放本回合则落协作图让时间线在图上播放。 */
function naturalTurnView(debate: boolean, replayThisTurn: boolean): TurnView {
  return debate && !replayThisTurn ? "room" : "graph";
}

/** Per conversation×turn: auto-open「最终回答」只跑一次，放大态 remount 不重复弹面板。 */
const autoOpenedFinalAnswer = new Set<string>();

/**
 * The canvas's 放大态 (前端UX设计.md §六 · Route A): one turn's full collaboration
 * DAG taking over the canvas surface, with zoom/pan + layout toolbar + replay
 * timeline. It replaces the old portal-to-body full-screen overlay — instead of a
 * second, parallel "全屏" concept, this is simply the canvas zoomed into a single
 * turn, rendered IN PLACE inside {@link import("./ConversationCanvas")} (no portal,
 * no global graph state). The overview ⇄ 放大 swap keeps exactly one interactive
 * ReactFlow mounted at a time, so the inner DAG owns pan/zoom here while the
 * overview owns it there — no nested-zoom conflict.
 *
 * Drill-ins: both a worker node AND an endpoint (用户输入 / CEO 汇聚点) hand off to
 * the conversation's shared right-docked {@link import("@/components/layout/SidePanel")}
 * — a worker as a run-detail tab, an endpoint as a content tab (提问 / 最终回答) — so
 * detail always opens to the right and the lit node survives leaving zoom. The final
 * answer auto-opens there once (no chat column alongside in canvas). The bottom
 * {@link CanvasCommandBar} dispatches the next order and this view follows the new
 * round in place. Esc steps back progressively: close the side panel → exit to the
 * overview; 返回 exits too. `autoplay` starts the replay timeline — the inline card's
 * 回放 entry — but only on the turn it opened on, never a follow.
 */
export function CanvasZoomedTurn({
  turnId,
  autoplay = false,
  initialView,
  onClose,
}: {
  turnId: string;
  autoplay?: boolean;
  /** 聊天侧信号深链的初始视图（如「对比」）；缺省走该回合自然默认（辩论=群聊 / 其余=协作图）。 */
  initialView?: CanvasFocusView;
  onClose: () => void;
}) {
  // The turn this view tracks: opens on `turnId`, but the command bar can switch
  // it to FOLLOW a freshly-dispatched round (issue an order, watch the next one on
  // the same canvas). Re-provided to descendants via ExecutionScopeContext.
  const [scopeId, setScopeId] = useState(turnId);
  const execution = useMessageExecution(scopeId);
  const taskSummary = execution?.taskSummary;
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const showContentDetail = useSidePanelStore((s) => s.showContentDetail);
  const messages = useActiveMessages();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  // 群聊掌舵需知本回合是否仍 live 可操作（决策卡 transport-only，重载即失）：取焦点回合的
  // isStreaming（与画布指挥台同口径）透传给 DebateStream。
  const interactive =
    messages.find((m) => m.id === scopeId)?.isStreaming ?? false;

  // 放大态视图切换 (前端UX设计.md §4.1/§六/§6.5)：群聊 (辩论室·统一 IM 主视图) / 对比
  // (统一对比透镜·可选) / 协作图 (依赖结构) / 并行时间线 (时间真相)。
  // 辩论默认落群聊、其余默认落图；回放本回合则落图让时间线在图上播放。对比 / 并行时间线恒为可选
  // 透镜 (从不作默认)。切回合 (跟随新指令) 时按新回合性质复位 (deps 含 scopeId)。
  const debate = !!execution && isDebate(execution);
  // 「对比」透镜出现条件 = 有可对比的东西：正反 2 方辩论 (逐轮擂台) 或本回合有定向唤回「修订 vN」
  // (版本链)。二者统一由 {@link TurnCompare} 承载（形态自适应），故此处只判「是否有」。
  const twoSideDebate =
    debate && execution ? toDebateModel(execution)?.form === "debate" : false;
  const revisable = !!execution && hasRevisions(execution);
  const canCompare = twoSideDebate || revisable;
  const parallel = !!execution && hasParallelTimeline(execution);
  // 深链初始视图（聊天侧「改了 N 版」信号 → 直达「对比」）：仅本回合首挂生效，跟随新回合 / 用户切换
  // 后让位给自然默认（辩论=群聊 / 其余=协作图），不与之打架。
  const pendingInitialView = useRef<TurnView | null>(
    initialView === "compare" ? "compare" : null,
  );
  const [view, setView] = useState<TurnView>(() => {
    if (pendingInitialView.current) return pendingInitialView.current;
    const replayThisTurn = autoplay && scopeId === turnId;
    const natural = naturalTurnView(debate, replayThisTurn);
    if (!conversationId) return natural;
    return resolveCanvasTurnView(
      loadCanvasTurnView(conversationId, scopeId),
      natural,
      new Set<TurnView>([natural, "graph"]),
    );
  });

  // The 放大态 view switcher's available tabs (≥2 ⇒ it renders): 群聊 for any debate,
  // 对比 (unified TurnCompare) when canCompare — i.e. a 正反 2-side debate (→ 逐轮擂台矩阵)
  // OR the turn has 定向唤回 revisions (→ 版本轨), 时间线 only when there's parallel-execution
  // data, 协作图 always.
  const viewTabs = useMemo(() => {
    const tabs: { id: TurnView; label: string; icon: ReactNode }[] = [];
    if (debate)
      tabs.push({
        id: "room",
        label: "群聊",
        icon: <MessagesSquare size={14} />,
      });
    if (canCompare)
      tabs.push({
        id: "compare",
        label: "对比",
        icon: <GitCompare size={14} />,
      });
    tabs.push({ id: "graph", label: "协作图", icon: <Network size={14} /> });
    if (parallel)
      tabs.push({
        id: "timeline",
        label: "并行时间线",
        icon: <Clock size={14} />,
      });
    return tabs;
  }, [debate, canCompare, parallel]);

  const availableViews = useMemo(
    () => new Set(viewTabs.map((t) => t.id)),
    [viewTabs],
  );

  useEffect(() => {
    // 深链视图在本回合首挂期间不被自然默认 / 持久偏好覆盖；切回合（跟随新指令）后正常恢复。
    if (pendingInitialView.current && scopeId === turnId) return;
    const replayThisTurn = autoplay && scopeId === turnId;
    const natural = naturalTurnView(debate, replayThisTurn);
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
  }, [debate, scopeId, autoplay, turnId, conversationId, availableViews]);

  const selectView = useCallback(
    (v: TurnView) => {
      setView(v);
      pendingInitialView.current = null;
      if (conversationId) persistCanvasTurnView(conversationId, scopeId, v);
    },
    [conversationId, scopeId],
  );

  const showRoom = debate && view === "room";
  const showCompare = canCompare && view === "compare";
  const showTimeline = parallel && view === "timeline";

  // This turn's final answer bubble (mirrors GraphView's `finalAnswer`): the
  // assistant message stamped with this execution id once the CEO starts writing.
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

  // Worker drill: pin the run in the shared docked panel WITHOUT leaving zoom, so
  // the detail opens to the right.
  const onNodeSelect = useCallback(
    (runId: string) => {
      const run = execution?.runs.find((r) => r.id === runId);
      const role = execution?.agents.find((a) => a.id === run?.agentId)?.role;
      showRunDetail(scopeId, runId, role);
    },
    [execution, scopeId, showRunDetail],
  );

  // Endpoint drill (提问 / 最终回答): open the bubble in the same right-docked panel
  // as a content tab — detail always opens to the right, lighting its endpoint node.
  const onEndpointSelect = useCallback(
    (contentMessageId: string, title: string, endpoint: EndpointKind) =>
      showContentDetail(scopeId, contentMessageId, title, endpoint),
    [scopeId, showContentDetail],
  );

  // No chat bubble alongside in canvas, so auto-surface the CEO final answer in the
  // right panel — once per conversation×turn (survives remount), never over a run
  // the user already drilled.
  useEffect(() => {
    if (!finalAnswerId || !conversationId) return;
    const latchKey = `${conversationId}:${scopeId}`;
    if (autoOpenedFinalAnswer.has(latchKey)) return;
    const sp = useSidePanelStore.getState();
    const onRunTab =
      sp.open &&
      sp.tabs.some((t) => t.id === sp.activeTabId && t.messageId === scopeId);
    if (onRunTab) return;
    autoOpenedFinalAnswer.add(latchKey);
    showContentDetail(scopeId, finalAnswerId, "最终回答", "answer");
  }, [finalAnswerId, scopeId, conversationId, showContentDetail]);

  // After the command bar dispatches, follow the new round — switch scope when its
  // executionId lands, or exit to the overview if the CEO answers directly (no
  // team graph). One-shot per dispatch.
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

  // Leaving 放大态 drops any endpoint content tab it surfaced (提问 / 最终回答) so it
  // doesn't linger beside the chat bubble on the way back to chat; a drilled run tab
  // is kept (§十「退出放大态后右坞仍展示同一 run」).
  useEffect(() => () => useSidePanelStore.getState().closeContentTabs(), []);

  // Progressive Esc: close the side panel (a drilled run or surfaced endpoint from
  // THIS turn) first, and only once it is gone does Esc leave the zoomed view.
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
    // Re-scope the subtree to the followed turn so the GraphView renders whichever
    // round this view tracks.
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
          {/* 放大态视图切换 (群聊 / 对比 / 协作图 / 并行时间线)：≥2 个可用视图才出现。 */}
          {viewTabs.length >= 2 && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
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

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {showRoom && execution ? (
            // 群聊页（辩论室·统一 IM 主视图）：自然时序单条群聊流（议题头 → 辩手左 / 你右 / 主持人左
            // （法槌头像+发言）→ 流末「主持人终审」唯一结论面），发言点角色钻右侧详情面板（与图节点 / 端点钻取同一 SidePanel）。
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <DebateStream
                execution={execution}
                messageId={scopeId}
                conversationId={conversationId}
                interactive={interactive}
              />
            </div>
          ) : showCompare && execution ? (
            // 对比页（统一对比透镜·可选）：辩论回合 = 逐轮擂台矩阵（脊 / 交锋 / 终审）；定向唤回修订
            // 回合 = 各被改 worker 的版本链左→右并排；点任意两格进共享精读对比面（2-up / 真·文本 diff）。
            // 发言 / 版本点头钻右侧详情面板（与图节点 / 端点钻取同一 SidePanel）。
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mx-auto max-w-5xl">
                <TurnCompare execution={execution} messageId={scopeId} />
              </div>
            </div>
          ) : showTimeline && execution ? (
            // 并行时间线页 (多任务并行图)：把队员执行铺在真实时间轴上，看真并发 / 串行化 / 关键路径。
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <ParallelTimeline execution={execution} />
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              {/* Remount per scope so a followed turn starts from a clean layout;
                autoplay is the 回放 entry — only the turn we opened on, never a follow. */}
              <GraphView
                key={scopeId}
                autoplay={autoplay && scopeId === turnId}
                onClose={onClose}
                onNodeSelect={onNodeSelect}
                onEndpointSelect={onEndpointSelect}
              />
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
