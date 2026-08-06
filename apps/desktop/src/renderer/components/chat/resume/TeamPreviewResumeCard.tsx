import { TEAM_PRIMITIVE_META } from "@/components/chat/decision";
import {
  DebatePreviewBody,
  WorkerPreviewRows,
  formatDebateBudgetLabel,
} from "@/components/chat/teamPreview";
import { toolLabelZh } from "@/components/chat/toolLabelsZh";
import {
  Badge,
  Button,
  DecisionCard,
  DecisionCardIcon,
  Textarea,
} from "@/components/ui";
import type { TeamPreviewResumeCorrections } from "@/services/interactionSubmit";
import type { PlanReviewUserDecision } from "@/services/planReview";
import type { PendingResume } from "@/stores/pausedTurns";
import {
  CheckCheck,
  ChevronRight,
  Loader2,
  OctagonX,
  Users,
} from "lucide-react";
import { useState } from "react";
import { useColdSubmit } from "./useColdSubmit";

/** Cold-path team_preview resume card (delegate / debate). */
export function TeamPreviewResumeCard({ turn }: { turn: PendingResume }) {
  const [note, setNote] = useState("");
  const [capsOpen, setCapsOpen] = useState(false);
  const [excludedRunIds, setExcludedRunIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [textOnlyRunIds, setTextOnlyRunIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const { submitting, busy, send } = useColdSubmit(turn);
  const isDebate = turn.primitive === "debate";
  const family = TEAM_PRIMITIVE_META[isDebate ? "debate" : "delegate"];
  const showCapabilities = !isDebate && turn.tools.length > 0;
  const debateBudget = isDebate
    ? formatDebateBudgetLabel(turn.maxRounds, turn.thorough)
    : null;

  const spinnerOr = (
    decision: PlanReviewUserDecision,
    icon: React.ReactNode,
  ) =>
    submitting === decision ? (
      <Loader2 size={13} className="animate-spin" />
    ) : (
      icon
    );

  const capPreview = turn.tools.slice(0, 2).map(toolLabelZh);
  const capRest = turn.tools.length - capPreview.length;

  const buildCorrections = (): TeamPreviewResumeCorrections | undefined => {
    if (isDebate) return undefined;
    const excluded_run_ids = turn.workers
      .map((w) => w.run_id)
      .filter((id) => excludedRunIds.has(id));
    const write_capability_overrides = turn.workers
      .filter(
        (w) =>
          !excludedRunIds.has(w.run_id) &&
          textOnlyRunIds.has(w.run_id) &&
          w.write_capability === "can_write_files",
      )
      .map((w) => ({
        run_id: w.run_id,
        capability: "text_only" as const,
      }));
    if (
      excluded_run_ids.length === 0 &&
      write_capability_overrides.length === 0
    ) {
      return undefined;
    }
    return {
      ...(excluded_run_ids.length > 0 ? { excluded_run_ids } : {}),
      ...(write_capability_overrides.length > 0
        ? { write_capability_overrides }
        : {}),
    };
  };

  const onExcludedChange = (runId: string, included: boolean) => {
    setExcludedRunIds((prev) => {
      const next = new Set(prev);
      if (included) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const onTextOnlyChange = (runId: string, textOnly: boolean) => {
    setTextOnlyRunIds((prev) => {
      const next = new Set(prev);
      if (textOnly) next.add(runId);
      else next.delete(runId);
      return next;
    });
  };

  return (
    <DecisionCard
      tone="primary"
      animate
      className="mx-0 flex max-h-[min(60vh,36rem)] flex-col overflow-hidden p-0"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="flex items-start gap-2">
            <DecisionCardIcon tone="primary">
              <Users size={16} />
            </DecisionCardIcon>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 flex-1 text-sm text-foreground">
                  {family.resumeLead}
                </p>
                {debateBudget && (
                  <Badge tone="muted" className="shrink-0 font-normal">
                    {debateBudget}
                  </Badge>
                )}
              </div>
              {isDebate ? (
                <DebatePreviewBody
                  debate={turn}
                  mode="collapsible"
                  showBudget={false}
                  motionClassName="whitespace-pre-wrap text-sm text-foreground"
                />
              ) : (
                <WorkerPreviewRows
                  mode="interactive"
                  workers={turn.workers}
                  excludedRunIds={excludedRunIds}
                  onExcludedChange={onExcludedChange}
                  textOnlyRunIds={textOnlyRunIds}
                  onTextOnlyChange={onTextOnlyChange}
                  disabled={busy}
                />
              )}

              {showCapabilities && (
                <div className="mt-2">
                  <p className="mb-1 text-xs text-muted-foreground">
                    可逆写入已由「本会话信任」放行；以下为执行类。
                  </p>
                  <button
                    type="button"
                    onClick={() => setCapsOpen((v) => !v)}
                    aria-expanded={capsOpen}
                    className="flex w-full items-center gap-1.5 text-left"
                  >
                    <ChevronRight
                      size={13}
                      className={`shrink-0 text-muted-foreground transition-transform ${
                        capsOpen ? "rotate-90" : ""
                      }`}
                    />
                    <span className="shrink-0 text-xs font-medium text-foreground">
                      将授权的执行能力
                    </span>
                    {!capsOpen && (
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {capPreview.join(" · ")}
                        {capRest > 0 ? ` · +${capRest}` : ""}
                      </span>
                    )}
                    {!capsOpen && capRest > 0 && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        +{capRest}
                      </span>
                    )}
                  </button>
                  {capsOpen && (
                    <div className="mt-1 flex flex-wrap gap-1 pl-5">
                      {turn.tools.map((tool) => (
                        <Badge key={tool} tone="muted" className="font-normal">
                          {toolLabelZh(tool)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="shrink-0 space-y-2 border-t border-border bg-card/95 px-3 py-3 backdrop-blur-sm">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder={family.notePlaceholder}
            className="w-full border-border bg-card/70 focus:border-primary/60"
          />
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            <Button
              variant="primary"
              icon={spinnerOr("continue", <CheckCheck size={13} />)}
              disabled={busy}
              onClick={() =>
                send("continue", [], note.trim(), buildCorrections())
              }
            >
              {isDebate
                ? family.resumeCta
                : showCapabilities
                  ? family.resumeCta
                  : "开做"}
            </Button>
            <Button
              variant="danger"
              icon={spinnerOr("stop", <OctagonX size={13} />)}
              disabled={busy}
              onClick={() => send("stop", [], note.trim())}
            >
              取消
            </Button>
          </div>
        </div>
      </div>
    </DecisionCard>
  );
}
