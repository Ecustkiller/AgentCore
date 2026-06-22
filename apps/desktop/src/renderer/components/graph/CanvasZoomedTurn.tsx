import { DebateBody } from "@/components/chat/DebateCompare";
import { Button } from "@/components/ui";
import { useActiveGenerating, useActiveMessages } from "@/stores/conversation";
import {
  ExecutionScopeContext,
  isDebate,
  useMessageExecution,
} from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { ArrowLeft, MessagesSquare, Network } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CanvasCommandBar } from "./CanvasCommandBar";
import { GraphView } from "./GraphView";

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
  onClose,
}: {
  turnId: string;
  autoplay?: boolean;
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

  // 辩论回合：放大态在「交锋叙事 ↔ 协作图」间切换 (前端UX设计.md §四/§六)。交锋页是主角
  // (决策简报 + 叙事线)、图作次级——辩论的 DAG 是固定低信息形状。默认落交锋；回放本回合则落
  // 图让时间线在图上播放。切回合 (跟随新指令) 时按新回合性质复位 (deps 含 scopeId)。
  const debate = !!execution && isDebate(execution);
  const [debateTab, setDebateTab] = useState<"clash" | "graph">(
    debate && !(autoplay && scopeId === turnId) ? "clash" : "graph",
  );
  useEffect(() => {
    const replayThisTurn = autoplay && scopeId === turnId;
    setDebateTab(debate && !replayThisTurn ? "clash" : "graph");
  }, [debate, scopeId, autoplay, turnId]);
  const showClash = debate && debateTab === "clash";

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
    (contentMessageId: string, title: string) =>
      showContentDetail(scopeId, contentMessageId, title),
    [scopeId, showContentDetail],
  );

  // No chat bubble alongside in canvas, so auto-surface the CEO final answer in the
  // right panel — once (ref latch), never over a run the user already drilled.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current || !finalAnswerId) return;
    autoOpenedRef.current = true;
    const sp = useSidePanelStore.getState();
    const onRunTab =
      sp.open &&
      sp.tabs.some((t) => t.id === sp.activeTabId && t.messageId === scopeId);
    if (onRunTab) return;
    showContentDetail(scopeId, finalAnswerId, "最终回答");
  }, [finalAnswerId, scopeId, showContentDetail]);

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
      autoOpenedRef.current = false;
      setFollowing(false);
    } else if (!last.isStreaming && !generating) {
      setFollowing(false);
      onClose();
    }
  }, [following, messages, generating, scopeId, onClose]);

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
    // Re-scope the subtree to the followed turn so GraphView + foot drawer render
    // whichever round this view tracks.
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
          {/* 辩论回合的「交锋叙事 ↔ 协作图」切换：交锋是主角、默认页，图作次级。 */}
          {debate && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
              <Button
                variant="ghost"
                onClick={() => setDebateTab("clash")}
                aria-pressed={debateTab === "clash"}
                icon={<MessagesSquare size={14} />}
                className={
                  debateTab === "clash"
                    ? "bg-accent text-foreground hover:bg-accent"
                    : undefined
                }
              >
                交锋叙事
              </Button>
              <Button
                variant="ghost"
                onClick={() => setDebateTab("graph")}
                aria-pressed={debateTab === "graph"}
                icon={<Network size={14} />}
                className={
                  debateTab === "graph"
                    ? "bg-accent text-foreground hover:bg-accent"
                    : undefined
                }
              >
                协作图
              </Button>
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {showClash && execution ? (
            // 交锋叙事页：决策简报 + 叙事线全高阅读区；各方发言点角色钻右侧详情面板
            // (与图节点钻取同一 SidePanel)。无脚抽屉——它是图页读 endpoint 的概念。
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <DebateBody execution={execution} messageId={scopeId} />
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
