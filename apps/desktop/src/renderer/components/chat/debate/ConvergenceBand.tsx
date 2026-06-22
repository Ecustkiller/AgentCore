import {
  debateSignalDot,
  statusAccentText,
} from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Check, Loader2 } from "lucide-react";
import { type DebateForm, type DebateRoundModel, roundSignal } from "./model";

/**
 * 收敛信号带 (辩论编排设计.md §4.2 「认知推进线」的 glanceable 概览，对标 Kialo minimap /
 * Argus confidence-evolution) —— 把整场「交锋 → 收敛」压成一条横向轴：每轮一个轴点 (颜色按
 * {@link roundSignal}：在飞脉动 / 收敛绿 / 有交锋蓝 / 各说各话灰)，连成线，终点标「收敛 / 进行中」。
 *
 * 它与下方竖向时间线是「概览 ↔ 细节」两级 (而非重复)：这条让用户 30 秒看懂「辩了几轮、在第几
 * 轮收敛」，时间线供逐轮深读。单轮或扁平旧批次无推进可言 → 调用方不挂本带。
 */
export function ConvergenceBand({
  rounds,
  form,
}: {
  rounds: DebateRoundModel[];
  form: DebateForm;
}) {
  if (rounds.length < 2) return null;
  const last = rounds[rounds.length - 1];
  const inFlight = rounds.some((r) => r.inFlight);
  const converged = !inFlight && Boolean(last.verdict?.converged);

  return (
    <div className="flex items-center gap-2.5">
      <span className="shrink-0 text-xs text-muted-foreground">交锋推进</span>
      <ol className="flex min-w-0 flex-1 items-center">
        {rounds.map((round, i) => {
          const isLast = i === rounds.length - 1;
          return (
            <li
              key={round.roundNo}
              className={`flex items-center ${isLast ? "" : "flex-1"}`}
            >
              <SimpleTooltip
                label={`第 ${round.roundNo} 轮${round.focus ? `：${round.focus}` : ""}`}
              >
                <span
                  className={`size-2.5 shrink-0 rounded-full ${debateSignalDot[roundSignal(round)]}`}
                />
              </SimpleTooltip>
              {!isLast && <span className="mx-1 h-px flex-1 bg-border" />}
            </li>
          );
        })}
      </ol>
      {inFlight ? (
        <span
          className={`flex shrink-0 items-center gap-1 text-xs ${statusAccentText.primary}`}
        >
          <Loader2 size={12} className="animate-spin" />
          进行中
        </span>
      ) : converged ? (
        <span
          className={`flex shrink-0 items-center gap-1 text-xs ${statusAccentText.success}`}
        >
          <Check size={12} />
          {`第 ${last.roundNo} 轮${form === "red_team" ? "挖尽" : "收敛"}`}
        </span>
      ) : null}
    </div>
  );
}
