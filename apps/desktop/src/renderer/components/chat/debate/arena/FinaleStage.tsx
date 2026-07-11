import { Button } from "@/components/ui";
import {
  confidenceLabel,
  confidencePill,
  statusAccentText,
} from "@/components/ui/tone-presets";
import { useDebateTake } from "@/stores/debateUserTake";
import type { Execution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import {
  Check,
  GitCompare,
  Scale,
  Swords,
  Target,
  TriangleAlert,
} from "lucide-react";
import { DebateContinue } from "../Continue";
import { ModelBadge } from "../ModelBadge";
import {
  type DebateModel,
  debateRoster,
  stopLabel,
  tallyScores,
} from "../model";
import { finaleAnchorId } from "./anchors";
import { BriefCard, RoundtableSpectrum } from "./brief";

export function FinaleStage({
  model,
  execution,
  messageId,
  onClose,
}: {
  model: DebateModel;
  execution: Execution;
  messageId: string;
  onClose?: () => void;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const moderatorRun = model.moderatorRunId
    ? execution.runs.find((r) => r.id === model.moderatorRunId)
    : undefined;
  const brief = model.brief;
  const sides = model.sides;
  const hasBrief = !!(brief && sides);
  const tally = model.form === "roundtable" ? [] : tallyScores(model.rounds);
  const scoresByKey: Record<string, number> = Object.fromEntries(
    tally.map((s) => [s.sideKey, s.total]),
  );

  const take = useDebateTake(messageId);
  const stanceSide =
    debateRoster(model.rounds).find((r) => r.sideKey === take.stance) ?? null;
  const stanceAgree = (() => {
    if (!stanceSide || tally.length < 2) return null;
    const sorted = [...tally].sort((a, b) => b.total - a.total);
    if (sorted[0].total === sorted[1].total) return null;
    return sorted[0].sideKey === stanceSide.sideKey;
  })();

  return (
    <div
      id={finaleAnchorId()}
      className="scroll-mt-28 mt-8 border-t-2 border-border pt-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        {moderatorRun ? (
          // 对齐 SpeakerBlock 惯例：身份行（标题 + 模型徽章）即钻取入口。
          <Button
            variant="ghost"
            onClick={() => showRunDetail(messageId, moderatorRun.id, "主持人")}
            className="h-auto justify-start gap-2 rounded-none px-0 py-0 hover:bg-transparent"
          >
            <h2 className="text-sm font-semibold text-foreground">
              主持人终审
            </h2>
            <ModelBadge model={moderatorRun.model ?? ""} />
          </Button>
        ) : (
          <h2 className="text-sm font-semibold text-foreground">主持人终审</h2>
        )}
        <span className="text-xs text-muted-foreground">
          {stopLabel(model.stopReason)}
        </span>
      </div>

      {hasBrief ? (
        <div className="mt-4 space-y-4">
          <FinaleHeadline brief={brief} form={model.form} />
          {model.form === "roundtable" && (
            <RoundtableSpectrum brief={brief} sides={sides} />
          )}
          <BriefCard
            brief={brief}
            sides={sides}
            form={model.form}
            scores={scoresByKey}
            sceneKey={`${messageId}:brief`}
          />
          {tally.length > 0 && <FinaleScoreboard tally={tally} />}
          {stanceAgree !== null && stanceSide && (
            <p
              className={`inline-flex items-center gap-1 text-xs ${stanceAgree ? statusAccentText.success : statusAccentText.muted}`}
            >
              {stanceAgree ? <Check size={12} /> : <GitCompare size={12} />}
              {stanceAgree
                ? "你的倾向与 AI 看似一致"
                : "你的倾向与 AI 或有不同"}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">结论简报生成中…</p>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <DebateContinue model={model} />
        {onClose && (
          <Button variant="neutral" onClick={onClose}>
            回到对话
          </Button>
        )}
      </div>
    </div>
  );
}

function FinaleHeadline({
  brief,
  form,
}: {
  brief: NonNullable<DebateModel["brief"]>;
  form: DebateModel["form"];
}) {
  if (form === "roundtable") return null;
  const label = form === "red_team" ? "方案评定" : "结论倾向";
  const level = confidenceLevel(brief.confidence);
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Scale size={13} />
          {label}
        </span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium ${confidencePill[level]}`}
        >
          置信 {confidenceLabel[level]}
        </span>
      </div>
      <p className="mt-1 text-xl font-semibold leading-snug text-foreground">
        {brief.leaning}
      </p>
      {brief.decisive && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Swords size={13} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium text-foreground">胜负手：</span>
            {brief.decisive}
          </span>
        </p>
      )}
      {brief.crux && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Target size={13} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium text-foreground">争点：</span>
            {brief.crux}
          </span>
        </p>
      )}
    </div>
  );
}

function FinaleScoreboard({
  tally,
}: {
  tally: ReturnType<typeof tallyScores>;
}) {
  const max = Math.max(1, ...tally.map((s) => Math.abs(s.total)));
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground">终盘比分</h4>
      {tally.map((s) => (
        <div key={s.sideKey} className="flex items-center gap-2">
          <span
            className="w-20 shrink-0 truncate text-xs font-medium"
            style={{ color: s.colorVar }}
          >
            {s.name}
          </span>
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${s.total > 0 ? Math.max(4, (s.total / max) * 100) : 0}%`,
                backgroundColor: s.colorVar,
                opacity: 0.6,
              }}
            />
          </div>
          <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums">
            {s.total}
          </span>
          {s.penalties.length > 0 && (
            <span className="inline-flex items-center gap-0.5 text-xs text-destructive">
              <TriangleAlert size={11} />
              {s.penalties.length}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

function confidenceLevel(raw: string): ConfidenceLevel {
  const s = raw.toLowerCase();
  if (CONFIDENCE_LEVELS.includes(s as ConfidenceLevel))
    return s as ConfidenceLevel;
  if (s.includes("high") || raw.includes("高")) return "high";
  if (s.includes("low") || raw.includes("低")) return "low";
  return "medium";
}
