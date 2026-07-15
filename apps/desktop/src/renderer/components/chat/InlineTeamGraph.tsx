import { DebateProgressLine } from "@/components/chat/DebateProgressLine";
import { StatusStrip } from "@/components/chat/StatusStrip";
import { TeamNotesPanel } from "@/components/chat/TeamNotesPanel";
import { teamNotesDefaultExpanded } from "@/components/chat/teamNotesDefaults";
import { GraphView } from "@/components/graph/GraphView";
import { planCapabilities } from "@/components/graph/planCapabilities";
import { ContextualTip } from "@/components/onboarding/ContextualTip";
import { formatCollabSummary } from "@/lib/collabSummary";
import {
  EMBED_DEFAULT_COL_WIDTH,
  estimateBbox,
  fitWidthBox,
  workerGraphShape,
} from "@/lib/elk-layout";
import { useConversationStore } from "@/stores/conversation";
import {
  usePersistentDisclosure,
  useStreamAwareDisclosure,
} from "@/stores/disclosure";
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
import { turnDetailPath } from "@/stores/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

/** Re-export for canvas 指挥台 and other consumers. */
export { RecoveryActions } from "@/components/chat/StatusStrip";

/**
 * True once the team has actually started work: any run left the never-started
 * states (`pending`, or terminal `skipped` from finalize before a start).
 * Gates the inline graph so team_preview hang / stop-before-start stay graph-less;
 * plan_review mid-wave pause (completed nodes exist) still shows the graph.
 */
export function teamHasStartedRuns(
  runs: readonly { status: string }[],
): boolean {
  return runs.some((r) => r.status !== "pending" && r.status !== "skipped");
}

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
 * right-side panel; 「在画布打开」/「回放」navigate to the turn's full-screen
 * detail page (`#/conversations/:id/turn/:turnId`).
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
  const notesPanelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  // 「在画布打开」/「回放」→ 全屏回合详情页（协作图 / 辩论室 / 对比）。
  const openInCanvas = useCallback(
    (autoplay: boolean) => {
      if (!conversationId) return;
      navigate(
        turnDetailPath(conversationId, messageId, undefined, undefined, {
          autoplay,
        }),
      );
    },
    [conversationId, messageId, navigate],
  );
  // 「改了 N 版」信号 → 深链全屏页的「对比」视图。
  const openRevisionsInCanvas = useCallback(() => {
    if (!conversationId) return;
    navigate(turnDetailPath(conversationId, messageId, "compare"));
  }, [conversationId, messageId, navigate]);
  const hydrateFromJournal = useExecutionStore((s) => s.hydrateFromJournal);
  useEffect(() => {
    if (journal) hydrateFromJournal(messageId, journal);
  }, [journal, messageId, hydrateFromJournal]);

  const execution = useMessageExecution(messageId);
  const message = useConversationStore((s) => {
    const key = s.currentConversationId ?? "";
    return s.byId[key]?.messages.find(
      (m) => m.id === messageId || m.serverMessageId === messageId,
    );
  });
  const collabSummary = useMemo(
    () => formatCollabSummary(message?.collab),
    [message?.collab],
  );
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

  const caps = planCapabilities(execution?.planType);
  // 内嵌协作图收起/展开：与画布 graph-fold 独立语义（不互通）。
  const [expanded, setExpanded] = usePersistentDisclosure(
    `${messageId}:inline-graph`,
    caps.inlineDefaultExpanded,
  );

  // 便签墙：运行中默认展开、结束默认折叠；用户选择跨卸载/刷新保留。
  const notesLive = teamNotesDefaultExpanded(
    execution?.status,
    execution?.teamNotes ?? [],
  );
  const [notesExpanded, , setNotesExpanded] = useStreamAwareDisclosure(
    `${messageId}:team-notes`,
    notesLive,
  );

  const openTeamNotes = useCallback(() => {
    setNotesExpanded(true);
    requestAnimationFrame(() => {
      notesPanelRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    });
  }, [setNotesExpanded]);

  if (
    !execution ||
    execution.id !== executionId ||
    !caps.showsTeamGraph ||
    !teamHasStartedRuns(execution.runs)
  ) {
    return null;
  }

  const graphHeight = measured?.height ?? fallbackHeight;

  return (
    <ExecutionScopeContext.Provider value={messageId}>
      <ContextualTip tipId="inline_team_graph" placement="top" active>
        <div className="animate-task-card-enter mb-3 overflow-hidden rounded-xl border border-border bg-card">
          {/* 辩论全过程 / 版本对比等「过程产物」不再内联聊天——它们归画布放大态（统一辩论室 /
              统一「对比」视图），聊天正文只在状态条留信号（辩论 pill /「改了 N 版」chip）+ 入口 CTA
              （前端UX设计.md §4.1/§4.2/§6.4）。 */}
          <StatusStrip
            execution={execution}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            onMaximize={() => openInCanvas(false)}
            onReplay={() => openInCanvas(true)}
            onOpenRevisions={openRevisionsInCanvas}
            onOpenTeamNotes={openTeamNotes}
            collabSummary={collabSummary}
          />
          {isDebate(execution) && (
            <DebateProgressLine
              execution={execution}
              disclosureKey={`${messageId}:debate-progress`}
            />
          )}
          {expanded && (
            <GraphArea
              execution={execution}
              messageId={messageId}
              height={graphHeight}
              onMeasure={onMeasure}
            />
          )}
          {/* 团队便签墙 (§2.2 通): collapsible; stays available when the graph is folded.
              Empty turns render nothing. */}
          <div ref={notesPanelRef}>
            <TeamNotesPanel
              notes={execution.teamNotes}
              expanded={notesExpanded}
              onExpandedChange={setNotesExpanded}
            />
          </div>
        </div>
      </ContextualTip>
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
      <GraphView
        interactive={false}
        fitMode="width"
        onNodeSelect={onNodeSelect}
        onMeasure={onMeasure}
      />
    </div>
  );
}
