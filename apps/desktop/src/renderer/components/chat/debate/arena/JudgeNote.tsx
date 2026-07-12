import { Loader2 } from "lucide-react";
import {
  type DebateForm,
  type DebateRoundModel,
  describeRoundVerdict,
} from "../model";
import type { DebateScoreView } from "../model";
import { ModeratorIdentity } from "./ModeratorIdentity";
import { ScoreBreakdownTip, formatNetTotal } from "./ScoreBreakdown";

/** 裁判札记横带：逐轮小结 / 小结空窗。身份壳与开场入场、质询报幕一致。 */
export function JudgeNote({
  text,
  round,
  form,
  pending,
  model,
}: {
  text: string;
  round?: DebateRoundModel;
  form?: DebateForm;
  pending?: boolean;
  /** 主持人模型；直播态 null → 身份行无徽章。 */
  model?: string | null;
}) {
  if (pending) {
    return (
      <div className="flex items-center gap-2 border-y border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
        <ModeratorIdentity model={model} gavelSize={13} className="text-xs" />
        <Loader2 size={13} className="animate-spin shrink-0" />
        <span>正在小结…</span>
      </div>
    );
  }

  const verdict = round?.verdict;
  const status = verdict && form ? describeRoundVerdict(verdict, form) : null;
  const scores = round?.scores ?? [];

  return (
    <div className="border-y border-border bg-muted/20 px-3 py-2.5">
      <div className="mb-1">
        <ModeratorIdentity model={model} gavelSize={14} className="text-xs" />
      </div>
      <div className="min-w-0">
        <p className="text-sm text-foreground">{text}</p>
        {(status || scores.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {status && (
              <span className="text-muted-foreground">{status.label}</span>
            )}
            {scores.length > 0 && <RoundScoreInline scores={scores} />}
          </div>
        )}
        {scores.some((s) => s.penalties.length > 0) && (
          <RoundPenalties scores={scores} />
        )}
      </div>
    </div>
  );
}

function RoundScoreInline({ scores }: { scores: DebateScoreView[] }) {
  return (
    <span className="tabular-nums text-foreground">
      {scores.map((s, i) => (
        <span key={s.sideKey}>
          {i > 0 && " · "}
          <ScoreBreakdownTip score={s}>
            <button
              type="button"
              className="inline rounded-lg border border-transparent px-0.5 hover:border-border hover:bg-muted/40"
            >
              <span style={{ color: s.colorVar }}>{s.name}</span>{" "}
              {formatNetTotal(s.total)}
            </button>
          </ScoreBreakdownTip>
        </span>
      ))}
    </span>
  );
}

/** 该轮罚分具体条目——可读列出，不再只挂 ⚠ 图标。 */
function RoundPenalties({ scores }: { scores: DebateScoreView[] }) {
  const withPenalties = scores.filter((s) => s.penalties.length > 0);
  if (withPenalties.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
      {withPenalties.map((s) => (
        <li key={s.sideKey}>
          <span style={{ color: s.colorVar }} className="font-medium">
            {s.name}
          </span>
          <span className="mx-1">·</span>
          <span>罚分：{s.penalties.join("；")}</span>
        </li>
      ))}
    </ul>
  );
}
