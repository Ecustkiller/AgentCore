import { shouldHostPreviewInGraph } from "@/components/chat/debatePreviewPlacement";
import {
  ResolvedDecisionRecord,
  teamCorrectionSuffix,
  teamPendingMarkerLabel,
  teamResolvedOutcome,
} from "@/components/chat/decision";
import {
  DebatePreviewBody,
  WorkerPreviewRows,
} from "@/components/chat/teamPreview";
import { Button } from "@/components/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { TeamPreviewDisplay } from "@/stores/conversation";
import { useMessageExecution } from "@/stores/execution";
import { PendingDecisionMarker } from "./PendingDecisionMarker";

/**
 * Inline team_preview card — thin preflight before fan-out / moderator start.
 * Actionable surface is the durable ResumePrompt (挂起即收口). 方案 C（一个焦点 +
 * 一个入口）: inline pending is a single-line {@link PendingDecisionMarker} — the
 * full 分工表 / 辩题立场 live on the ResumePrompt 拍板中心; resolved keeps a
 * collapsible settled trace (one-line conclusion; expand for plan details + note).
 * plan_review resolved 不占时间线，结论收进图节点 checkpoint 徽标。
 *
 * Branches on ``primitive``: delegate = 队员分工表; debate = 辩题 / 立场 / 轮次预算.
 *
 * Resolved + team already started: content hosts in {@link GraphTeamPreview}
 * on the inline StatusStrip (see {@link shouldHostPreviewInGraph}); this card
 * returns null so the timeline does not keep a spare card slot.
 *
 * Resolved copy / icons come from the shared decision meta ({@link TEAM_PRIMITIVE_META}).
 */
export function TeamPreviewCard({
  preview,
  messageId,
}: {
  preview: TeamPreviewDisplay;
  /** Assistant message id — used to gate resolved embed into the graph. */
  messageId?: string;
}) {
  const execution = useMessageExecution(messageId ?? null);
  if (shouldHostPreviewInGraph(preview, execution?.runs)) {
    return null;
  }
  if (preview.status === "resolved") {
    return <ResolvedTeamPreview preview={preview} />;
  }
  return (
    <PendingDecisionMarker
      label={teamPendingMarkerLabel(preview.primitive, summarySuffix(preview))}
    />
  );
}

function isDebate(preview: TeamPreviewDisplay): boolean {
  return preview.primitive === "debate";
}

function summarySuffix(preview: TeamPreviewDisplay): string {
  if (isDebate(preview)) {
    const n = preview.sides.length;
    return n > 0 ? `${n} 方` : "辩论";
  }
  return `${preview.workers.length} 名队员`;
}

function graphPreviewSummary(preview: TeamPreviewDisplay): string {
  if (isDebate(preview)) {
    const n = preview.sides.length;
    return n > 0 ? `辩题 · ${n} 方` : "辩题";
  }
  const n = preview.workers.length;
  return n > 0 ? `分工 · ${n} 名队员` : "分工";
}

/**
 * Secondary ghost control for StatusStrip — Popover hosts 辩题 / 分工 details
 * (DebatePreviewBody / WorkerPreviewRows + optional note). No DecisionCard shell; does not
 * navigate to the debate room. Mounted only on the inline StatusStrip path.
 */
export function GraphTeamPreview({
  preview,
}: {
  preview: TeamPreviewDisplay;
}) {
  const summary = graphPreviewSummary(preview);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="ml-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          data-testid="graph-team-preview"
        >
          {summary}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3 [&>*:first-child]:mt-0">
        {isDebate(preview) ? (
          <DebatePreviewBody debate={preview} />
        ) : (
          <WorkerPreviewRows workers={preview.workers} />
        )}
        {preview.note && (
          <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-foreground">
            {preview.note}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ResolvedTeamPreview({ preview }: { preview: TeamPreviewDisplay }) {
  const decision = preview.decision ?? "timeout";
  const meta = teamResolvedOutcome(
    preview.primitive,
    decision,
    Boolean(preview.note?.trim()),
  );
  const correction = teamCorrectionSuffix({
    excluded_run_ids: preview.excluded_run_ids,
    write_capability_overrides: preview.write_capability_overrides,
  });
  const summary = `${meta.label}${correction} · ${summarySuffix(preview)}`;

  return (
    <ResolvedDecisionRecord
      layout="neutralCollapsible"
      disclosureKey={`team-preview:${preview.id}`}
      icon={meta.icon}
      summary={summary}
    >
      {isDebate(preview) ? (
        <DebatePreviewBody debate={preview} />
      ) : (
        <WorkerPreviewRows workers={preview.workers} />
      )}
      {preview.note && (
        <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-foreground">
          {preview.note}
        </p>
      )}
    </ResolvedDecisionRecord>
  );
}
