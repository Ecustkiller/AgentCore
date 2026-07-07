import { Gavel, Loader2, TriangleAlert } from "lucide-react";
import {
  type DebateForm,
  type DebateRoundModel,
  describeRoundVerdict,
} from "../model";
import type { DebateScoreView } from "../model";

/** 裁判札记横带：开场 / 逐轮小结 / 小结空窗。 */
export function JudgeNote({
  text,
  round,
  form,
  pending,
}: {
  text: string;
  round?: DebateRoundModel;
  form?: DebateForm;
  pending?: boolean;
}) {
  if (pending) {
    return (
      <div className="flex items-center gap-2 border-y border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
        <Gavel size={13} className="shrink-0" />
        <Loader2 size={13} className="animate-spin" />
        主持人正在小结…
      </div>
    );
  }

  const verdict = round?.verdict;
  const status = verdict && form ? describeRoundVerdict(verdict, form) : null;
  const scores = round?.scores ?? [];

  return (
    <div className="border-y border-border bg-muted/20 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Gavel size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">{text}</p>
          {(status || scores.length > 0) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {status && (
                <span className="text-muted-foreground">{status.label}</span>
              )}
              {scores.length > 0 && <RoundScoreInline scores={scores} />}
            </div>
          )}
        </div>
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
          <span style={{ color: s.colorVar }}>{s.name}</span>{" "}
          {s.total >= 0 ? "+" : ""}
          {s.total}
          {s.penalties.length > 0 && (
            <TriangleAlert
              size={11}
              className="ml-0.5 inline text-destructive"
            />
          )}
        </span>
      ))}
    </span>
  );
}
