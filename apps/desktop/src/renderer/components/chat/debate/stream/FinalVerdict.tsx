import { Button } from "@/components/ui";
import { countPillMuted, statusAccentText } from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useDebateTake } from "@/stores/debateUserTake";
import type { Execution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { Check, ClipboardList, GitCompare, Info, TriangleAlert } from "lucide-react";
import type { Ref } from "react";
import {
  BriefCard,
  Disclosure,
  RoundtableSpectrum,
  VerdictHeadline,
  verdictHeadTint,
  verdictTopBorder,
} from "../Brief";
import { DebateContinue } from "../Continue";
import { ModelBadge } from "../ModelBadge";
import {
  type DebateModel,
  type DebateScoreView,
  debateRoster,
  stopLabel,
  tallyScores,
} from "../model";
import { ModeratorAvatar } from "./Moderator";

/**
 * 流末「主持人终审」= 辩论的**唯一结论面**（收场）：自然时序的终点——读完逐轮交锋后，主持人在流末
 * 给出完整裁决。呈现为主持人的**收尾长发言气泡**（法槌头像 + 满宽中性气泡，与逐轮小结
 * {@link ModeratorSpeech} 同构——主持人全程是「群里说话的同一个人」，只是终审这条发言正文更丰富）。
 */
export function FinalVerdict({
  model,
  execution,
  messageId,
  verdictRef,
}: {
  model: DebateModel;
  execution: Execution;
  messageId: string;
  verdictRef: Ref<HTMLDivElement>;
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
    <div ref={verdictRef} className="flex scroll-mt-2 justify-start">
      <div className="flex w-full gap-2">
        <ModeratorAvatar model={moderatorRun?.model} />
        <div
          className="min-w-0 flex-1 overflow-hidden rounded-xl border border-t-2 border-border bg-card"
          style={{ borderTopColor: verdictTopBorder }}
        >
          <div className="px-3 pb-2.5 pt-2" style={verdictHeadTint}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-medium text-foreground">
                主持人终审
              </span>
              <ModelBadge model={moderatorRun?.model ?? ""} />
              <span className={countPillMuted}>
                {stopLabel(model.stopReason)}
              </span>
              <span className="min-w-0 flex-1" />
              {moderatorRun && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    showRunDetail(messageId, moderatorRun.id, "主持人")
                  }
                  className="h-auto px-0 py-0 text-xs text-primary hover:bg-transparent"
                >
                  裁决过程
                </Button>
              )}
            </div>
            {hasBrief && <VerdictHeadline brief={brief} form={model.form} />}
          </div>

          <div className="px-3 pb-2.5 pt-2.5">
            {hasBrief ? (
              <div className="space-y-3">
                {model.form === "roundtable" && (
                  <RoundtableSpectrum brief={brief} sides={sides} />
                )}
                <BriefCard
                  brief={brief}
                  sides={sides}
                  form={model.form}
                  scores={scoresByKey}
                />
                {tally.length > 0 && <Scoreboard tally={tally} />}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">结论简报生成中…</p>
            )}

            {stanceAgree !== null && stanceSide && (
              <div
                className={`mt-2 inline-flex items-center gap-1 text-xs ${stanceAgree ? statusAccentText.success : statusAccentText.muted}`}
              >
                {stanceAgree ? <Check size={12} /> : <GitCompare size={12} />}
                {stanceAgree
                  ? "你的倾向与 AI 看似一致"
                  : "你的倾向与 AI 或有不同"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 记分总览（记分裁判 P2 · 收场）—— 把逐轮记分累计成每方净分。 */
function Scoreboard({ tally }: { tally: DebateScoreView[] }) {
  const max = Math.max(1, ...tally.map((s) => Math.abs(s.total)));
  const teaser = tally.map((s) => `${s.name} ${s.total}`).join(" · ");
  const summary = (
    <span className="inline-flex items-center gap-1">
      <ClipboardList size={14} />
      记分总览
      <SimpleTooltip label="逐轮记分累计的净分（论点强度 + 回应完整度 + 证据充分度 − 谬误/无据罚分）。它佐证下方倾向——AI 据实际交锋记分定倾向，而非拍脑袋。">
        <span
          className="inline-flex shrink-0 cursor-help text-muted-foreground"
          aria-label="记分总览是什么"
        >
          <Info size={12} />
        </span>
      </SimpleTooltip>
    </span>
  );
  return (
    <Disclosure summary={summary} teaser={teaser}>
      <div className="space-y-1.5 pt-1">
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
                }}
              />
            </div>
            <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-foreground">
              {s.total}
            </span>
            {s.penalties.length > 0 && (
              <SimpleTooltip
                label={`罚分 ${s.penalties.length} 项：${s.penalties.join("；")}`}
              >
                <span className="inline-flex shrink-0 cursor-help items-center gap-0.5 text-xs text-destructive">
                  <TriangleAlert size={11} />
                  {s.penalties.length}
                </span>
              </SimpleTooltip>
            )}
          </div>
        ))}
      </div>
    </Disclosure>
  );
}
