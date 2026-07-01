import { StatusStrip } from "@/components/chat/StatusStrip";
import { TeamNotesPanel } from "@/components/chat/TeamNotesPanel";
import { GraphView } from "@/components/graph/GraphView";
import {
  EMBED_DEFAULT_COL_WIDTH,
  estimateBbox,
  fitWidthBox,
  workerGraphShape,
} from "@/lib/elk-layout";
import { useConversationStore } from "@/stores/conversation";
import {
  type Execution,
  type ExecutionJournal,
  ExecutionScopeContext,
  isDebate,
  useExecutionStore,
  useMessageExecution,
} from "@/stores/execution";
import { useGraphStore } from "@/stores/graph";
import { useSidePanelStore } from "@/stores/sidePanel";
import { useUIStore } from "@/stores/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

/** Re-export for canvas 指挥台 and other consumers. */
export { RecoveryActions } from "@/components/chat/StatusStrip";

/**
 * The multi-agent turn's primary surface, embedded in the assistant message
 * above its answer: a compact status strip (lifecycle + cost + recovery) over
 * the live collaboration graph. It is the in-chat "team界面" that replaced the
 * old free-floating `TaskCard` + auto-opening detail panel + permanent graph
 * overlay — one graph, one place (前端UX设计.md §三).
 *
 * The strip can collapse the graph away (the answer stays right below), and the
 * canvas height adapts to team size so a small team does not float in a big box.
 *
 * Per-message (§9.3): keyed by the assistant message id, so live and reloaded
 * (historical) multi-agent turns render identically — the live turn streams into
 * the slot, a reloaded turn hydrates it from the persisted journal (`runs`), and
 * both project through the same fold. Node clicks drill into the passive
 * right-side panel; 「在画布打开」/「回放」switch to the canvas zoomed into this turn
 * (放大态, Route A) — there is no separate full-screen overlay.
 */
export function InlineTeamGraph({
  messageId,
  executionId,
  journal,
}: {
  messageId: string;
  executionId: string;
  journal?: ExecutionJournal;
}) {
  // null = 未手动切换，跟随按回合性质推导的默认（辩论收起 / 普通展开）；一旦用户切换即以其为准。
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(
    null,
  );
  const setConversationView = useUIStore((s) => s.setConversationView);
  const requestCanvasFocus = useUIStore((s) => s.requestCanvasFocus);
  const conversationId = useConversationStore((s) => s.currentConversationId);
  // 「在画布打开」/「回放」统一通向画布的放大态（Route A，再无独立全屏）：把目标回合（+ 是否
  // 自动回放）塞进 UI store 后切到画布视图，画布挂载即放大该回合。会话 id 在首发即赋值，故协作图
  // 出现时一定已有 id；defensively 无 id 则不切。
  const openInCanvas = useCallback(
    (autoplay: boolean) => {
      if (!conversationId) return;
      requestCanvasFocus(messageId, autoplay);
      setConversationView(conversationId, "canvas");
    },
    [conversationId, messageId, requestCanvasFocus, setConversationView],
  );
  // 「改了 N 版」信号 → 深链画布放大态的统一「对比」视图直达（聊天正文已不再内联此卡，
  // 前端UX设计.md §4.2/§6.4：过程产物归画布、正文只留信号）。
  const openRevisionsInCanvas = useCallback(() => {
    if (!conversationId) return;
    requestCanvasFocus(messageId, false, "compare");
    setConversationView(conversationId, "canvas");
  }, [conversationId, messageId, requestCanvasFocus, setConversationView]);
  const hydrateFromJournal = useExecutionStore((s) => s.hydrateFromJournal);
  useEffect(() => {
    if (journal) hydrateFromJournal(messageId, journal);
  }, [journal, messageId, hydrateFromJournal]);

  const execution = useMessageExecution(messageId);

  const [measured, setMeasured] = useState<{
    height: number;
    overflowing: boolean;
  } | null>(null);
  const onMeasure = useCallback(
    (m: { height: number; overflowing: boolean }) => setMeasured(m),
    [],
  );
  const layoutKind = useGraphStore((s) => s.layoutKind);
  const fallbackHeight = useMemo(() => {
    if (!execution) return 0;
    const est = estimateBbox(workerGraphShape(execution.runs), layoutKind);
    return fitWidthBox(est.width, est.height, EMBED_DEFAULT_COL_WIDTH).height;
  }, [execution, layoutKind]);

  if (
    !execution ||
    execution.id !== executionId ||
    execution.planType === "single_agent"
  ) {
    return null;
  }

  const graphHeight = measured?.height ?? fallbackHeight;
  // 辩论回合默认收起协作图：辩论正文归画布「辩论室」、聊天占位精简为状态条 + 醒目「打开辩论室」CTA
  // （前端UX设计.md §4.2）；普通团队回合默认展开。用户手动切换后以其选择为准（expandedOverride）。
  const isDebateTurn = isDebate(execution);
  const expanded = expandedOverride ?? !isDebateTurn;

  return (
    <ExecutionScopeContext.Provider value={messageId}>
      <div className="animate-task-card-enter mb-3 overflow-hidden rounded-xl border border-border bg-card">
        {/* 辩论全过程 / 版本对比等「过程产物」不再内联聊天——它们归画布放大态（统一辩论室 /
            统一「对比」视图），聊天正文只在状态条留信号（辩论 pill /「改了 N 版」chip）+ 入口 CTA
            （前端UX设计.md §4.1/§4.2/§6.4）。 */}
        <StatusStrip
          execution={execution}
          expanded={expanded}
          onToggle={() => setExpandedOverride(!expanded)}
          onMaximize={() => openInCanvas(false)}
          onReplay={() => openInCanvas(true)}
          onOpenRevisions={openRevisionsInCanvas}
        />
        {expanded && (
          <GraphArea
            execution={execution}
            messageId={messageId}
            height={graphHeight}
            onMeasure={onMeasure}
          />
        )}
        {/* 团队便签墙 (§2.2 通): the one-line decisions / heads-ups workers broadcast to their
            concurrent siblings this turn — shown whether the graph is expanded or collapsed, so
            it stays a compact, always-visible artifact. Renders nothing for a turn with no notes. */}
        <TeamNotesPanel notes={execution.teamNotes} />
      </div>
    </ExecutionScopeContext.Provider>
  );
}

function GraphArea({
  execution,
  messageId,
  height,
  onMeasure,
}: {
  execution: Execution;
  messageId: string;
  height: number;
  onMeasure: (m: { height: number; overflowing: boolean }) => void;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);

  const onNodeSelect = (runId: string) => {
    const run = execution.runs.find((r) => r.id === runId);
    const role = execution.agents.find((a) => a.id === run?.agentId)?.role;
    showRunDetail(messageId, runId, role);
  };

  return (
    <div
      className="w-full select-none border-t border-border transition-[height] duration-200 motion-reduce:transition-none"
      style={{ height }}
    >
      <GraphView embedded onNodeSelect={onNodeSelect} onMeasure={onMeasure} />
    </div>
  );
}
