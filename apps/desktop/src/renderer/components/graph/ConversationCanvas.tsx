import { useApprovalStore } from "@/stores/approvals";
import {
  useBackgroundTasks,
  useBackgroundTasksSync,
} from "@/stores/backgroundTasks";
import {
  useActiveError,
  useActiveGenerating,
  useActiveMessages,
  useConversationStore,
} from "@/stores/conversation";
import {
  type Execution,
  ExecutionScopeContext,
  projectExecution,
  useExecutionStore,
} from "@/stores/execution";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { Network } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CanvasCommandBar } from "./CanvasCommandBar";
import {
  CanvasDecisionPanel,
  countPendingDecisions,
  isTurnRecoverable,
} from "./CanvasDecisionPanel";
import {
  FOCUS_NODE_HEIGHT,
  FOCUS_NODE_WIDTH,
  type FocusedTurnData,
  FocusedTurnNode,
} from "./FocusedTurnNode";
import { type SimpleTurnData, SimpleTurnNode } from "./SimpleTurnNode";
import { TeamGraphFullscreen } from "./TeamGraphFullscreen";
import { type TurnSummaryData, TurnSummaryNode } from "./TurnSummaryNode";

/**
 * 对话级画布（前端UX设计.md §6.1 · 持久累积 + LOD）. The opt-in second
 * view {@link import("../../pages/ConversationPage")} renders in place of {@link
 * import("../chat/ChatView")} when the conversation's view mode is "canvas" (画布
 * 已毕业，无实验开关——入口恒显示、对话页默认聊天，前端UX设计.md §六）。
 *
 * 乙-1 单张持久画布: ONE pannable surface where every turn accumulates as a node, top
 * → bottom (视觉累积), with a minimap + camera (ReactFlow Controls). Identity
 * continuity (「同一拨人」) rides on `agentIdentity` — same role ⇒ same avatar across
 * turns — WITHOUT backend worker实体化 (= 乙-2, 否, 见设计 §八).
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

const TURN_NODE_WIDTH = 320;
// Collapsed-turn slot heights (must clear each card incl. a running team's progress
// bar) so turns stack without overlap; the focused turn uses FOCUS_NODE_HEIGHT.
const TEAM_NODE_HEIGHT = 132;
const SIMPLE_NODE_HEIGHT = 96;
const GAP_Y = 40;

const turnNodeTypes = {
  focusedTurn: FocusedTurnNode,
  teamTurn: TurnSummaryNode,
  simpleTurn: SimpleTurnNode,
};

interface TurnItem {
  id: string;
  kind: "team" | "simple";
  exec: Execution | null;
  prompt: string;
  answer: string;
  running: boolean;
}

/** Distinct member roles in first-seen order — drives a team node's identity avatars. */
function dedupeRoles(exec: Execution): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of exec.agents) {
    const r = a.role?.trim();
    if (!r || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

export function ConversationCanvas() {
  const messages = useActiveMessages();
  const generating = useActiveGenerating();
  const byId = useExecutionStore((s) => s.byId);

  // Hydrate reloaded team turns from their persisted journal so their summary
  // projects even though the chat view's InlineTeamGraph isn't mounted here.
  // Idempotent (a slot that already holds a plan is left untouched); reads the
  // store imperatively to avoid a byId dependency loop.
  useEffect(() => {
    const store = useExecutionStore.getState();
    for (const m of messages) {
      if (
        m.role === "assistant" &&
        m.executionId &&
        m.runs &&
        !store.byId[m.id]?.plan
      ) {
        store.hydrateFromJournal(m.id, m.runs);
      }
    }
  }, [messages]);

  // Fold messages into a turn spine: team turns project their execution, simple
  // turns carry the prompt (preceding user message) + answer snippet.
  const turns = useMemo<TurnItem[]>(() => {
    const out: TurnItem[] = [];
    let lastUser = "";
    for (const m of messages) {
      if (m.role === "user") {
        lastUser = m.content;
        continue;
      }
      if (m.role !== "assistant") continue;
      if (m.executionId) {
        const rt = byId[m.id];
        const exec = rt?.plan
          ? projectExecution(
              rt.plan,
              rt.frames.slice(0, rt.playhead ?? rt.frames.length),
              rt.status,
              rt.debate,
              rt.debateRounds,
            )
          : null;
        out.push({
          id: m.id,
          kind: "team",
          exec,
          prompt: lastUser,
          answer: m.content,
          running: exec?.status === "running" || m.isStreaming,
        });
      } else {
        out.push({
          id: m.id,
          kind: "simple",
          exec: null,
          prompt: lastUser,
          answer: m.content,
          running: m.isStreaming,
        });
      }
    }
    return out;
  }, [messages, byId]);

  const latestTeamId = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].kind === "team") return turns[i].id;
    }
    return null;
  }, [turns]);

  // Exactly one focused team turn. Default + auto-follow the latest; a click on a
  // collapsed summary switches focus (until a new turn lands and re-follows).
  const [focusedTurn, setFocusedTurn] = useState<string | null>(null);
  useEffect(() => {
    if (latestTeamId) setFocusedTurn(latestTeamId);
  }, [latestTeamId]);
  const effectiveFocus = useMemo(() => {
    if (
      focusedTurn &&
      turns.some((t) => t.id === focusedTurn && t.kind === "team")
    ) {
      return focusedTurn;
    }
    return latestTeamId;
  }, [focusedTurn, turns, latestTeamId]);

  // The team turn whose full DAG is open in the on-demand overlay (全屏 deep work).
  const [overlayTurn, setOverlayTurn] = useState<string | null>(null);

  // 图上指挥 (§6.2): pending boss decisions + 救火 + 后台云端任务 surface in a right-
  // docked 指挥台. Three scopes: the focused turn's (ask_user / plan_review / 工作者上报 /
  // 救火行), this conversation's level (approval / resume / transport-retry), and its
  // 后台云端任务 (handoff jobs) — all hosted by ChatView / InlineTeamGraph / MessageList,
  // which are unmounted in canvas mode, so they'd otherwise be invisible here.
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const focusedItem = useMemo(
    () => turns.find((t) => t.id === effectiveFocus) ?? null,
    [turns, effectiveFocus],
  );
  const focusedMessage = useMemo(
    () => messages.find((m) => m.id === effectiveFocus),
    [messages, effectiveFocus],
  );
  const turnDecisions = countPendingDecisions(
    focusedMessage,
    focusedItem?.exec,
  );
  const approvalCount = useApprovalStore(
    (s) => s.pending.filter((p) => p.conversationId === conversationId).length,
  );
  const resumeCount = usePausedTurnStore(
    (s) => s.pending.filter((p) => p.conversationId === conversationId).length,
  );
  const pendingTotal = turnDecisions + approvalCount + resumeCount;

  // 后台云端任务 (handoff jobs, 非阻塞 · 跨对话的另一类): chat mode runs this sync in
  // MessageList, which is unmounted here — so drive it from the always-mounted canvas
  // (it stays alive while the 指挥台 may be closed, so the count below can still
  // surface the panel). Non-blocking, so it is kept OUT of pendingTotal (the 待你拍板
  // decision badge / node chip) and only feeds the panel's auto-surface separately.
  useBackgroundTasksSync(conversationId);
  const backgroundCount = useBackgroundTasks(conversationId).length;

  // 救火: a conversation-level transport error (send / resume / regenerate drop) or
  // the focused turn's terminal failure also belongs on the 指挥台 (ChatView /
  // InlineTeamGraph are unmounted here, so their RetryBanner / 救火行 would vanish).
  const convError = useActiveError();
  const firefighting = !!convError || isTurnRecoverable(focusedItem?.exec);

  // Auto-open while anything is pending OR recoverable; dismissible (X), but re-armed
  // when focus moves OR a NEW item arrives (decision count rises / firefighting newly
  // appears) so a fresh decision / failure always resurfaces.
  const [panelDismissed, setPanelDismissed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm (un-dismiss) when the focused turn changes — the body resets state, it doesn't read effectiveFocus.
  useEffect(() => {
    setPanelDismissed(false);
  }, [effectiveFocus]);
  const actionable = pendingTotal + (firefighting ? 1 : 0) + backgroundCount;
  const prevActionable = useRef(0);
  useEffect(() => {
    if (actionable > prevActionable.current) setPanelDismissed(false);
    prevActionable.current = actionable;
  }, [actionable]);
  const panelOpen =
    (pendingTotal > 0 || firefighting || backgroundCount > 0) &&
    !panelDismissed;

  const nodes = useMemo<Node[]>(() => {
    const out: Node[] = [];
    let y = 0;
    for (const t of turns) {
      const focused = t.kind === "team" && t.id === effectiveFocus;
      const width = focused ? FOCUS_NODE_WIDTH : TURN_NODE_WIDTH;
      const height = focused
        ? FOCUS_NODE_HEIGHT
        : t.kind === "team"
          ? TEAM_NODE_HEIGHT
          : SIMPLE_NODE_HEIGHT;
      // Center every node on x=0 regardless of width so the spine reads straight.
      const position = { x: -(width / 2), y };
      if (focused) {
        const data: FocusedTurnData = {
          messageId: t.id,
          onMaximize: () => setOverlayTurn(t.id),
        };
        out.push({
          id: t.id,
          type: "focusedTurn",
          position,
          data,
          draggable: false,
        });
      } else if (t.kind === "team") {
        const exec = t.exec;
        const data: TurnSummaryData = {
          taskSummary: exec?.taskSummary || t.prompt || "团队回合",
          status: exec?.status ?? "planning",
          roles: exec ? dedupeRoles(exec) : [],
          agentCount: exec?.agents.length ?? 0,
          completed: exec?.progress.completed ?? 0,
          total: exec?.progress.total ?? 0,
        };
        out.push({
          id: t.id,
          type: "teamTurn",
          position,
          data,
          draggable: false,
        });
      } else {
        const data: SimpleTurnData = {
          prompt: t.prompt,
          answer: t.answer,
          running: t.running,
        };
        out.push({
          id: t.id,
          type: "simpleTurn",
          position,
          data,
          draggable: false,
        });
      }
      y += height + GAP_Y;
    }
    return out;
  }, [turns, effectiveFocus]);

  // The accumulation spine: a thin connector between consecutive turns so the
  // canvas reads as one continuous record rather than scattered cards.
  const edges = useMemo<Edge[]>(
    () =>
      turns.slice(1).map((t, i) => ({
        id: `${turns[i].id}->${t.id}`,
        source: turns[i].id,
        target: t.id,
        type: "smoothstep",
        selectable: false,
        style: { stroke: "var(--border)" },
      })),
    [turns],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    // Click a collapsed team summary → focus it (expands in place). The focused
    // node, the spine, and simple cards are inert here.
    if (node.type === "teamTurn") setFocusedTurn(node.id);
  }, []);

  // Camera: fit on first paint, then keep the focused turn centered — covers both a
  // manual focus switch and a newly-arrived turn (which auto-follows into focus).
  const rfRef = useRef<ReactFlowInstance | null>(null);
  useEffect(() => {
    const rf = rfRef.current;
    if (!rf || !effectiveFocus) return;
    const n = nodes.find((x) => x.id === effectiveFocus);
    if (n) {
      rf.setCenter(0, n.position.y + FOCUS_NODE_HEIGHT / 2, {
        zoom: 0.75,
        duration: 400,
      });
    }
  }, [effectiveFocus, nodes]);

  const miniMapColor = useCallback((n: Node) => {
    if (n.type === "teamTurn") {
      const s = (n.data as TurnSummaryData).status;
      if (s === "running") return "var(--primary)";
      if (s === "completed") return "var(--success)";
      if (s === "failed") return "var(--destructive)";
    }
    if (n.type === "focusedTurn") return "var(--primary)";
    return "var(--muted-foreground)";
  }, []);

  // Command-bar dispatch hint, cleared when generation settles.
  const [dispatched, setDispatched] = useState(false);
  useEffect(() => {
    if (!generating) setDispatched(false);
  }, [generating]);

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Slim header: labels the view + reserves the top band so the page's floating
            view / side-panel toggles (left-3 / right-3, top-2) clear the canvas. */}
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
        <div className="relative min-h-0 flex-1">
          {turns.length > 0 ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={turnNodeTypes}
              onNodeClick={onNodeClick}
              onInit={(inst) => {
                rfRef.current = inst;
                inst.fitView({ padding: 0.2, maxZoom: 1 });
              }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              minZoom={0.2}
              maxZoom={1.5}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <MiniMap
                pannable
                zoomable
                nodeColor={miniMapColor}
                className="!bg-card"
              />
              <Controls showInteractive={false} />
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
        </div>
        <CanvasCommandBar
          onDispatch={() => setDispatched(true)}
          waiting={dispatched && generating}
          allowBackground
        />
      </div>
      {/* 图上指挥指挥台 (§6.2): pending boss decisions + 救火 (turn-level + conversation-
          level), docked right. `message` may be undefined (approval / error-only turn). */}
      {panelOpen && (
        <CanvasDecisionPanel
          message={focusedMessage}
          execution={focusedItem?.exec}
          conversationId={conversationId}
          interactive={focusedMessage?.isStreaming ?? false}
          pending={pendingTotal}
          onClose={() => setPanelDismissed(true)}
        />
      )}
      {/* 全屏 deep work: drill the focused turn into the on-demand overlay (full
          detail panel + answer + command bar), scoped to its message. */}
      {overlayTurn && (
        <ExecutionScopeContext.Provider value={overlayTurn}>
          <TeamGraphFullscreen onClose={() => setOverlayTurn(null)} />
        </ExecutionScopeContext.Provider>
      )}
    </div>
  );
}
