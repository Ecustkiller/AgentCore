import type { Execution } from "@/stores/execution";
import { tallyScores, toDebateModel } from "./model";

const FORM_LABEL: Record<string, string> = {
  debate: "正反",
  red_team: "红队审查",
  roundtable: "圆桌探讨",
};

/** StatusStrip 辩论分支预告片文案（§3.4）。 */
export function debatePreviewSubtitle(execution: Execution): string {
  const model = toDebateModel(execution);
  if (!model) return "辩论";

  const rounds = model.rounds.length;
  const formLabel = FORM_LABEL[model.form] ?? "辩论";

  if (!model.settled) {
    const liveNo =
      model.rounds.find((r) => r.inFlight)?.roundNo ?? (rounds || 1);
    return `辩论 · 第 ${liveNo} 轮进行中`;
  }

  if (model.form === "debate") {
    const tally = tallyScores(model.rounds);
    if (tally.length >= 2) {
      const sorted = [...tally].sort((a, b) => b.total - a.total);
      if (sorted[0].total !== sorted[1].total) {
        return `辩论完成 · 正反 ${rounds} 轮 · ${sorted[0].name}方略占优`;
      }
    }
    return `辩论完成 · 正反 ${rounds} 轮`;
  }

  return `辩论完成 · ${formLabel} ${rounds} 轮`;
}
