import { DebateCompare } from "@/components/chat/DebateCompare";
import { RevisionCompare } from "@/components/chat/RevisionCompare";
import { StatusStrip } from "@/components/chat/StatusStrip";
import { GraphView } from "@/components/graph/GraphView";
import { TeamGraphFullscreen } from "@/components/graph/TeamGraphFullscreen";
import {
  EMBED_DEFAULT_COL_WIDTH,
  estimateBbox,
  fitWidthBox,
  workerGraphShape,
} from "@/lib/elk-layout";
import {
  type Execution,
  type ExecutionJournal,
  ExecutionScopeContext,
  hasRevisions,
  isDebate,
  useExecutionStore,
  useMessageExecution,
} from "@/stores/execution";
import { useGraphStore } from "@/stores/graph";
import { useSidePanelStore } from "@/stores/sidePanel";
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
 * right-side panel; the maximize button opens the full-screen graph (replay).
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
  const [expanded, setExpanded] = useState(true);
  const [fullscreen, setFullscreen] = useState<false | "view" | "replay">(
    false,
  );
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

  return (
    <ExecutionScopeContext.Provider value={messageId}>
      <div className="animate-task-card-enter mb-3 overflow-hidden rounded-xl border border-border bg-card">
        <StatusStrip
          execution={execution}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          onMaximize={() => setFullscreen("view")}
          onReplay={() => setFullscreen("replay")}
        />
        {expanded && (
          <GraphArea
            execution={execution}
            messageId={messageId}
            height={graphHeight}
            onMeasure={onMeasure}
          />
        )}
        {fullscreen && (
          <TeamGraphFullscreen
            autoplay={fullscreen === "replay"}
            onClose={() => setFullscreen(false)}
          />
        )}
      </div>
      {isDebate(execution) && (
        <DebateCompare execution={execution} messageId={messageId} />
      )}
      {hasRevisions(execution) && (
        <RevisionCompare execution={execution} messageId={messageId} />
      )}
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
