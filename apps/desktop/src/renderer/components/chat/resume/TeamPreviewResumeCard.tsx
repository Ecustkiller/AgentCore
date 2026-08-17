import {
  TEAM_PRIMITIVE_META,
  type TeamRevisionMeta,
  teamPreviewLead,
  teamPreviewRevisionVersionLabel,
} from "@/components/chat/decision";
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
import { cn } from "@/lib/utils";
import type { TeamPreviewResumeCorrections } from "@/services/interactionSubmit";
import type { PlanReviewUserDecision } from "@/services/planReview";
import type { KickoffPrimitive } from "@/stores/conversation";
import { useInteractionStore } from "@/stores/interactions";
import type { PendingResume } from "@/stores/pausedTurns";
import {
  CheckCheck,
  ChevronRight,
  Loader2,
  OctagonX,
  Pencil,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ResumeDeferredNotice } from "./ResumeDeferredNotice";
import {
  clearTeamPreviewKickoffDraft,
  useTeamPreviewKickoffDraft,
} from "./teamPreviewKickoffDraft";
import {
  REVISION_NOTE_CLAMP_CHARS,
  lookupPreviousTeamPreviewPayload,
  snapshotFromResume,
  teamPreviewRevisionDiff,
} from "./teamPreviewRevision";
import { useColdSubmit } from "./useColdSubmit";

/**
 * Cold-path team_preview resume card (delegate / debate).
 * 两态：确认（开工 / 调整 / 取消）→ 调整（必填意见，无开工键；提交中 CTA loading）。
 * 壳对齐 AskCardShell：中性单表面，卡内不铺品牌色；彩色只留给主 CTA。
 */
export function TeamPreviewResumeCard({ turn }: { turn: PendingResume }) {
  const { draft, update, discardAdjust } = useTeamPreviewKickoffDraft(
    turn.conversationId,
    turn.checkpointId,
  );
  const [noteOpen, setNoteOpen] = useState(() =>
    Boolean(draft.continueNote.trim()),
  );
  const continueNoteRef = useRef<HTMLTextAreaElement>(null);
  const adjustNoteRef = useRef<HTMLTextAreaElement>(null);
  const [capsOpen, setCapsOpen] = useState(false);
  const [textOnlyRunIds, setTextOnlyRunIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const isDebate = turn.primitive === "debate";
  const primitive: KickoffPrimitive = isDebate ? "debate" : "delegate";
  // 结算成功后只清存储、不动本地 state——改 state 会让卡在卸载前闪回确认态。
  const { submitting, busy, deferredBusyReason, send } = useColdSubmit(
    turn,
    () => clearTeamPreviewKickoffDraft(turn.conversationId, turn.checkpointId),
  );
  const settlementLocked = deferredBusyReason !== null;
  const family = TEAM_PRIMITIVE_META[primitive];
  const lead = teamPreviewLead({
    primitive,
    headline: turn.headline,
    workerCount: turn.workers.length,
    sideCount: turn.sides.length,
  });
  const versionLabel = teamPreviewRevisionVersionLabel(
    primitive,
    turn.revision,
  );
  const previousPayload = useInteractionStore((s) =>
    lookupPreviousTeamPreviewPayload(turn.revisedFrom, s.byId),
  );
  const revisionDiff = versionLabel
    ? teamPreviewRevisionDiff({
        primitive,
        current: snapshotFromResume(turn),
        previousPayload,
      })
    : null;
  const showCapabilities = !isDebate && turn.tools.length > 0;
  const debateBudget = isDebate
    ? formatDebateBudgetLabel(turn.maxRounds, turn.thorough)
    : null;
  const adjusting = draft.mode === "adjust";

  useEffect(() => {
    if (noteOpen && !adjusting) continueNoteRef.current?.focus();
  }, [adjusting, noteOpen]);

  useEffect(() => {
    if (adjusting && !busy) adjustNoteRef.current?.focus();
  }, [adjusting, busy]);

  const spinnerOr = (
    decision: PlanReviewUserDecision,
    icon: React.ReactNode,
  ) =>
    submitting === decision || (settlementLocked && decision === "continue") ? (
      <Loader2 size={13} className="animate-spin" />
    ) : (
      icon
    );

  const capPreview = turn.tools.slice(0, 2).map(toolLabelZh);
  const capRest = turn.tools.length - capPreview.length;

  /**
   * 人改模型 / 排除岗 UI 已撤：不再收集 model_overrides / excluded_run_ids
   *（契约透传路径仍在 useColdSubmit；resolved 回放对账仍可读后端字段）。
   */
  const buildCorrections = (): TeamPreviewResumeCorrections | undefined => {
    if (isDebate) return undefined;
    const write_capability_overrides = turn.workers
      .filter(
        (w) =>
          textOnlyRunIds.has(w.run_id) &&
          w.write_capability === "can_write_files",
      )
      .map((w) => ({
        run_id: w.run_id,
        capability: "text_only" as const,
      }));
    if (write_capability_overrides.length === 0) return undefined;
    return { write_capability_overrides };
  };

  const onTextOnlyChange = (runId: string, textOnly: boolean) => {
    setTextOnlyRunIds((prev) => {
      const next = new Set(prev);
      if (textOnly) next.add(runId);
      else next.delete(runId);
      return next;
    });
  };

  const submitAdjust = () => {
    const note = draft.adjustNote.trim();
    if (!note) {
      adjustNoteRef.current?.focus();
      return;
    }
    send("adjust", [], note);
  };

  return (
    <DecisionCard
      tone="neutral"
      animate
      className="mx-0 flex max-h-[min(60vh,36rem)] flex-col overflow-hidden p-0"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="flex items-start gap-2">
            <DecisionCardIcon tone="neutral">
              <Users size={16} />
            </DecisionCardIcon>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 flex-1 text-sm font-medium text-foreground">
                  {lead}
                </p>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                  {versionLabel ? (
                    <Badge
                      tone="muted"
                      className="font-normal"
                      data-testid="team-preview-revision-version"
                    >
                      {versionLabel}
                    </Badge>
                  ) : null}
                  {debateBudget ? (
                    <Badge tone="muted" className="font-normal">
                      {debateBudget}
                    </Badge>
                  ) : null}
                </div>
              </div>
              {versionLabel ? (
                <TeamPreviewRevisionBlock
                  copy={family.revision}
                  note={turn.revisionNote}
                  diff={revisionDiff}
                />
              ) : null}
              {isDebate ? (
                <DebatePreviewBody
                  mode="collapsible"
                  debate={turn}
                  showBudget={false}
                  motionClassName="whitespace-pre-wrap text-sm text-foreground"
                />
              ) : adjusting ? (
                <WorkerPreviewRows mode="readonly" workers={turn.workers} />
              ) : (
                <WorkerPreviewRows
                  mode="interactive"
                  workers={turn.workers}
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

        <div className="shrink-0 space-y-2 border-t border-border px-3 py-3">
          {settlementLocked && deferredBusyReason ? (
            <ResumeDeferredNotice busyReason={deferredBusyReason} />
          ) : null}
          {adjusting && !settlementLocked ? (
            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">
                调整意见（必填）
              </p>
              <Textarea
                ref={adjustNoteRef}
                value={draft.adjustNote}
                onChange={(e) => update({ adjustNote: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey) return;
                  e.preventDefault();
                  submitAdjust();
                }}
                disabled={busy}
                rows={3}
                placeholder={family.adjustPlaceholder}
                className="w-full border-border bg-card/70 focus:border-primary/60"
                data-testid="team-preview-adjust-note"
              />
            </div>
          ) : null}
          {!adjusting && !settlementLocked ? (
            <div>
              <button
                type="button"
                onClick={() => setNoteOpen((v) => !v)}
                aria-expanded={noteOpen}
                className="flex w-full items-center gap-1.5 text-left"
              >
                <ChevronRight
                  size={13}
                  className={`shrink-0 text-muted-foreground transition-transform ${
                    noteOpen ? "rotate-90" : ""
                  }`}
                />
                <span className="shrink-0 text-xs text-muted-foreground">
                  加一句嘱咐（可选）
                </span>
                {!noteOpen && draft.continueNote.trim() && (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">
                    {draft.continueNote.trim()}
                  </span>
                )}
              </button>
              {noteOpen ? (
                <div className="mt-1.5 pl-5">
                  <Textarea
                    ref={continueNoteRef}
                    value={draft.continueNote}
                    onChange={(e) => update({ continueNote: e.target.value })}
                    disabled={busy}
                    rows={2}
                    placeholder={family.notePlaceholder}
                    className="w-full border-border bg-card/70 focus:border-primary/60"
                    data-testid="team-preview-note"
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            {adjusting && !settlementLocked ? (
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                disabled={busy}
                onClick={discardAdjust}
              >
                返回
              </Button>
            ) : null}
            {!adjusting && !settlementLocked ? (
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                icon={spinnerOr("stop", <OctagonX size={13} />)}
                disabled={busy}
                onClick={() => send("stop", [], draft.continueNote.trim())}
              >
                取消
              </Button>
            ) : null}
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {adjusting && !settlementLocked ? (
                <Button
                  variant="primary"
                  icon={spinnerOr("adjust", <Pencil size={13} />)}
                  disabled={busy || !draft.adjustNote.trim()}
                  onClick={submitAdjust}
                >
                  {family.adjustCta}
                </Button>
              ) : null}
              {!adjusting && !settlementLocked ? (
                <Button
                  variant="neutral"
                  icon={<Pencil size={13} />}
                  disabled={busy}
                  onClick={() => update({ mode: "adjust" })}
                >
                  调整
                </Button>
              ) : null}
              {!adjusting ? (
                <Button
                  variant="primary"
                  icon={spinnerOr("continue", <CheckCheck size={13} />)}
                  disabled={busy}
                  onClick={() =>
                    send(
                      "continue",
                      [],
                      draft.continueNote.trim(),
                      buildCorrections(),
                    )
                  }
                >
                  {settlementLocked
                    ? "已记下"
                    : isDebate
                      ? family.resumeCta
                      : showCapabilities
                        ? family.resumeCta
                        : "开做"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </DecisionCard>
  );
}

function TeamPreviewRevisionBlock({
  copy,
  note,
  diff,
}: {
  copy: TeamRevisionMeta;
  note?: string;
  diff: ReturnType<typeof teamPreviewRevisionDiff> | null;
}) {
  const trimmedNote = (note ?? "").trim();
  const showChanges = diff?.status === "ready" && diff.lines.length > 0;
  return (
    <div className="mt-1.5 space-y-1.5" data-testid="team-preview-revision">
      <p className="text-xs text-muted-foreground">{copy.caption}</p>
      {trimmedNote ? <RevisionNote text={trimmedNote} copy={copy} /> : null}
      {showChanges && diff ? (
        <div data-testid="team-preview-revision-changes">
          <p className="text-xs text-muted-foreground">{copy.changesLead}</p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-xs text-foreground">
            {diff.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function RevisionNote({
  text,
  copy,
}: {
  text: string;
  copy: TeamRevisionMeta;
}) {
  const [open, setOpen] = useState(false);
  const long = text.length > REVISION_NOTE_CLAMP_CHARS || text.includes("\n");
  return (
    <div data-testid="team-preview-revision-note">
      <p className="text-xs text-muted-foreground">{copy.noteLabel}</p>
      <p
        className={cn(
          "mt-0.5 whitespace-pre-wrap text-xs text-foreground",
          !open && long && "line-clamp-2",
        )}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {open ? copy.noteCollapse : copy.noteExpand}
        </button>
      ) : null}
    </div>
  );
}
