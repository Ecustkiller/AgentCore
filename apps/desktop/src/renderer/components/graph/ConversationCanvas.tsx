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
  type ExecutionRuntime,
  projectExecution,
  useExecutionStore,
} from "@/stores/execution";
import { usePausedTurnStore } from "@/stores/pausedTurns";
import { useUIStore } from "@/stores/ui";
import {
  Background,
  type Edge,
  type Node,
  Panel,
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
import { CanvasTurnRail, type TurnRailItem } from "./CanvasTurnRail";
import { CanvasZoomControls } from "./CanvasZoomControls";
import { CanvasZoomedTurn } from "./CanvasZoomedTurn";
import {
  FOCUS_NODE_HEIGHT,
  FOCUS_NODE_WIDTH,
  type FocusedTurnData,
  FocusedTurnNode,
} from "./FocusedTurnNode";
import { type SimpleTurnData, SimpleTurnNode } from "./SimpleTurnNode";
import { type TurnSummaryData, TurnSummaryNode } from "./TurnSummaryNode";
import { prefersReducedMotion } from "./constants";

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
  /** 待你拍板: unanswered boss decisions on this turn (ask_user / plan_review / 工作者上报);
   * 0 for simple turns. Drives the folded summary node's warning chip (图上指挥扫视). */
  pendingDecisions: number;
  /** 待救火: this turn has recoverable terminal trouble (failed / cancelled / 部分失败);
   * false for simple turns. Drives the folded summary node's destructive chip. */
  recoverable: boolean;
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

/**
 * Per-slot projection cache (守 前端UX设计.md §八 ≤50 节点 / ≥60fps). The execution
 * store's `patchExec` replaces ONLY the mutated message's {@link ExecutionRuntime}
 * object on every streamed frame, leaving every settled turn's `rt` reference intact
 * — so keying by `rt` identity means a finished turn folds exactly once and the live
 * turn is the only slot re-projected per frame, and a scrub / status change (a fresh
 * `rt`) self-invalidates. Without this the overview re-folded EVERY past team turn
 * (each O(frames × runs)) on every token → O(turns × frames × runs) per frame, which
 * degrades a long conversation's frame rate. WeakMap so dropped slots are collectable.
 */
const projectionCache = new WeakMap<ExecutionRuntime, Execution>();
function projectSlot(rt: ExecutionRuntime | undefined): Execution | null {
  if (!rt?.plan) return null;
  const cached = projectionCache.get(rt);
  if (cached) return cached;
  const exec = projectExecution(
    rt.plan,
    rt.frames.slice(0, rt.playhead ?? rt.frames.length),
    rt.status,
    rt.debate,
    rt.debateRounds,
  );
  projectionCache.set(rt, exec);
  return exec;
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
        const exec = projectSlot(byId[m.id]);
        out.push({
          id: m.id,
          kind: "team",
          exec,
          prompt: lastUser,
          answer: m.content,
          running: exec?.status === "running" || m.isStreaming,
          // 图上指挥扫视 (§6.2): surface 待你拍板 / 待救火 on the FOLDED summary node so a
          // long spine shows which turns need the boss without focusing each one. Same
          // predicates the 指挥台 + focused node use, so the scent never disagrees.
          pendingDecisions: countPendingDecisions(m, exec),
          recoverable: isTurnRecoverable(exec),
        });
      } else {
        out.push({
          id: m.id,
          kind: "simple",
          exec: null,
          prompt: lastUser,
          answer: m.content,
          running: m.isStreaming,
          pendingDecisions: 0,
          recoverable: false,
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

  // New-turn 轻入场 (§六): track which turns have been seen, so only a GENUINELY new
  // turn animates in — not the whole spine on canvas open, and not a node remounting on
  // a focus switch. Recorded after render; the nodes memo reads it on the render an id
  // first appears (before this effect runs), so `enter` is true that once, then false.
  // Applied to simple turns (a new team turn auto-focuses and animates via its inner DAG
  // cascade, and the auto-focus would otherwise consume the flag a frame early).
  const seenTurnsRef = useRef<Set<string>>(new Set());
  const firstSpineRef = useRef(true);
  useEffect(() => {
    for (const t of turns) seenTurnsRef.current.add(t.id);
    firstSpineRef.current = false;
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

  // The team turn zoomed to fill the canvas (放大态, 前端UX设计.md §六 · Route A): its
  // full DAG takes over the surface IN PLACE (no portal overlay). null = 总览态; the
  // overview stays mounted underneath so 返回 / Esc restores it exactly.
  //
  // 总览↔放大 camera transition (相机过渡): the focused turn is parked at the viewport
  // center (see the camera effect below), so the 放大态 dives in from center — it scales
  // up + fades in while the overview pushes back a touch, reading as a camera flying into
  // that turn. `zoomShown` drives the CSS; on exit it recedes and unmounts on transitionend
  // (reduced motion skips the animation and swaps instantly).
  const reduceMotion = prefersReducedMotion();
  const [zoomedTurn, setZoomedTurn] = useState<string | null>(null);
  const [zoomAutoplay, setZoomAutoplay] = useState(false);
  const [zoomShown, setZoomShown] = useState(false);
  const revealRaf = useRef(0);
  const openZoom = useCallback(
    (turnId: string, replay: boolean) => {
      setZoomedTurn(turnId);
      setZoomAutoplay(replay);
      setFocusedTurn(turnId);
      if (reduceMotion) setZoomShown(true);
    },
    [reduceMotion],
  );
  // Reveal one frame after mount so the entry transition runs from the hidden state.
  useEffect(() => {
    if (!zoomedTurn || reduceMotion) return;
    revealRaf.current = requestAnimationFrame(() => setZoomShown(true));
    return () => cancelAnimationFrame(revealRaf.current);
  }, [zoomedTurn, reduceMotion]);
  const exitZoom = useCallback(() => {
    // Kill a still-pending entry reveal so closing in the same frame can't re-show it.
    cancelAnimationFrame(revealRaf.current);
    setZoomShown(false);
    // No transitionend fires under reduced motion, so unmount straight away.
    if (reduceMotion) {
      setZoomedTurn(null);
      setZoomAutoplay(false);
    }
  }, [reduceMotion]);

  // Consume a「在画布打开 / 回放」request from the chat-side inline graph (UI store
  // bridge): zoom straight into that turn (+ autoplay for 回放), align the focus so
  // the 指挥台 reflects it, then clear the request (用完即清, no stale re-trigger).
  const pendingCanvasFocus = useUIStore((s) => s.pendingCanvasFocus);
  const clearCanvasFocus = useUIStore((s) => s.clearCanvasFocus);
  useEffect(() => {
    if (!pendingCanvasFocus) return;
    openZoom(pendingCanvasFocus.turnId, pendingCanvasFocus.autoplay);
    clearCanvasFocus();
  }, [pendingCanvasFocus, clearCanvasFocus, openZoom]);

  // Bridge 放大态 to the page so it can hide the conversation-level floating toggles
  // (聊天/画布、侧面板) that would otherwise overlap — and occlude — 放大态's own top
  // chrome (返回 / 图工具栏). Cleared on exit AND unmount (切回聊天 / 离开对话) so the
  // toggles can never get stranded hidden.
  const setCanvasZoomed = useUIStore((s) => s.setCanvasZoomed);
  useEffect(() => {
    setCanvasZoomed(zoomedTurn != null);
    return () => setCanvasZoomed(false);
  }, [zoomedTurn, setCanvasZoomed]);

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
          onMaximize: () => openZoom(t.id, false),
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
          pendingDecisions: t.pendingDecisions,
          recoverable: t.recoverable,
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
          enter: !firstSpineRef.current && !seenTurnsRef.current.has(t.id),
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
  }, [turns, effectiveFocus, openZoom]);

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

  // 回合轨道 (§六): a lightweight status index of every turn for long spines. Maps the
  // turn spine to the rail's minimal shape (decoupled from TurnItem internals).
  const railItems = useMemo<TurnRailItem[]>(
    () =>
      turns.map((t) => ({
        id: t.id,
        kind: t.kind,
        status: t.exec?.status ?? null,
        running: t.running,
        pendingDecisions: t.pendingDecisions,
        recoverable: t.recoverable,
        label:
          t.exec?.taskSummary ||
          t.prompt ||
          (t.kind === "team" ? "团队回合" : "直接回答"),
      })),
    [turns],
  );

  // Rail click: a team turn focuses (expands in place; the camera effect frames it);
  // a simple turn can't focus, so center the camera on its card instead. Both bring
  // the turn into view on a long spine.
  const onRailSelect = useCallback((id: string, kind: "team" | "simple") => {
    if (kind === "team") {
      setFocusedTurn(id);
    } else {
      rfRef.current?.fitView({
        nodes: [{ id }],
        padding: 0.3,
        maxZoom: 1,
        duration: 300,
      });
    }
  }, []);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    // Click a collapsed team summary → focus it (expands in place). The focused
    // node, the spine, and simple cards are inert here.
    if (node.type === "teamTurn") setFocusedTurn(node.id);
  }, []);

  // Double-click a team turn → jump straight to 放大态, skipping the old two-step
  // (点聚焦 → 点 ⤢). On a collapsed summary the first click focuses it and the
  // dblclick (which fires on the persistent node wrapper) then zooms; on the already-
  // focused node it mirrors its ⤢ button. zoomOnDoubleClick is off so this never also
  // fires ReactFlow's pane zoom underneath.
  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type === "teamTurn" || node.type === "focusedTurn") {
        openZoom(node.id, false);
      }
    },
    [openZoom],
  );

  // Camera: fit on first paint, then keep the focused turn framed by FITTING the node
  // (not a fixed zoom) — covers a manual focus switch and a newly-arrived turn (which
  // auto-follows into focus). Fit-to-node replaces the old constant 0.75: the 760px-wide
  // focus node overflowed horizontally on narrow windows / with the side panel open, so
  // fit zooms out just enough, capped at 1 so it never over-magnifies a single node.
  const rfRef = useRef<ReactFlowInstance | null>(null);
  const canvasBoxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rf = rfRef.current;
    if (!rf || !effectiveFocus) return;
    if (!nodes.some((x) => x.id === effectiveFocus)) return;
    rf.fitView({
      nodes: [{ id: effectiveFocus }],
      padding: 0.2,
      maxZoom: 1,
      duration: 400,
    });
  }, [effectiveFocus, nodes]);

  // Re-frame the focused turn when the canvas WIDTH changes — the 指挥台 docking /
  // undocking on the right (§6.2), the side panel opening, or the window resizing
  // shrinks this surface, and the camera effect above only fires on focus / node
  // changes, so without this the focused node slides off-center (or behind the
  // panel). Mirrors the 放大态 GraphView's resize refit: debounced, with the first
  // (mount) observation skipped since onInit already framed it. Reads focus from a
  // ref so the observer is installed once (no teardown per streamed frame).
  const effectiveFocusRef = useRef<string | null>(effectiveFocus);
  effectiveFocusRef.current = effectiveFocus;
  useEffect(() => {
    const el = canvasBoxRef.current;
    if (!el) return;
    let lastWidth = Math.round(el.clientWidth);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (!settled) {
        settled = true;
        lastWidth = w;
        return;
      }
      if (w <= 0 || w === lastWidth) return;
      lastWidth = w;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const rf = rfRef.current;
        const focus = effectiveFocusRef.current;
        if (!rf || !focus || !rf.getNode(focus)) return;
        rf.fitView({
          nodes: [{ id: focus }],
          padding: 0.2,
          maxZoom: 1,
          duration: 300,
        });
      }, 160);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  // Command-bar dispatch hint, cleared when generation settles.
  const [dispatched, setDispatched] = useState(false);
  useEffect(() => {
    if (!generating) setDispatched(false);
  }, [generating]);

  return (
    <div className="flex min-w-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">
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
        <div
          ref={canvasBoxRef}
          className={`relative min-h-0 flex-1 origin-center transition-transform duration-200 ease-out motion-reduce:transition-none ${
            zoomedTurn && zoomShown ? "scale-[1.03]" : "scale-100"
          }`}
        >
          {turns.length > 0 ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={turnNodeTypes}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onInit={(inst) => {
                rfRef.current = inst;
                inst.fitView({ padding: 0.2, maxZoom: 1 });
              }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              zoomOnDoubleClick={false}
              minZoom={0.2}
              maxZoom={1.5}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              {/* 缩放/适应控件：替换 ReactFlow 默认 Controls（其浅底硬编码样式不走设计 token）。
                  MiniMap 已去掉——竖直单链的小地图信息量低、只添堵。 */}
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
          {/* 回合轨道 (§六): right-edge status index for long spines (self-hides when
              short). Chrome, so it sits OUTSIDE ReactFlow — it never pans / zooms. */}
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
        {/* 放大态 (Route A): the focused turn's full DAG covers the overview in place
            (no portal). Overview stays mounted underneath so 返回 / Esc restores it
            exactly. The 相机过渡 dives in from center (scale + fade); on exit it recedes
            and unmounts once the leave fade ends (child / entry transitionends ignored). */}
        {zoomedTurn && (
          <div
            className={`absolute inset-0 z-20 origin-center transition duration-200 ease-out motion-reduce:transition-none ${
              zoomShown ? "scale-100 opacity-100" : "scale-[0.92] opacity-0"
            }`}
            onTransitionEnd={(e) => {
              if (
                e.target === e.currentTarget &&
                e.propertyName === "opacity" &&
                !zoomShown
              ) {
                setZoomedTurn(null);
                setZoomAutoplay(false);
              }
            }}
          >
            <CanvasZoomedTurn
              key={zoomedTurn}
              turnId={zoomedTurn}
              autoplay={zoomAutoplay}
              onClose={exitZoom}
            />
          </div>
        )}
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
    </div>
  );
}
