import type { Execution } from "@/stores/execution";
import type { TeamSynthesisPreviewPayload } from "@/types/events";

/** Worker runs only (CEO captain sink is not a delegate progress unit). */
export function workerProgress(execution: Execution): {
  completed: number;
  total: number;
} {
  const workers = execution.runs.filter((r) => r.kind !== "captain");
  return {
    completed: workers.filter((r) => r.status === "completed").length,
    total: workers.length,
  };
}

/**
 * All workers finished while the turn is still running — CEO synthesis /
 * proposal_pick gap. Matches {@link deriveCaptainStatus}'s "running" sink.
 */
export function isTeamSynthesizing(execution: Execution): boolean {
  if (execution.status !== "running") return false;
  const { completed, total } = workerProgress(execution);
  return total > 0 && completed >= total;
}

/** Deterministic strip / indicator copy for the synthesis empty window. */
export function teamSynthesisPhaseLabel(execution: Execution): string {
  const { completed, total } = workerProgress(execution);
  return `${completed}/${total} 已完成，正在生成汇总`;
}

/**
 * Short preview for the CEO graph node while final answer is not yet streaming
 * into the bubble (synthesis uses `team_synthesis_preview`, not content_delta).
 */
export function captainSynthesisPreviewText(
  preview: TeamSynthesisPreviewPayload | null | undefined,
): string {
  if (!preview) return "";
  const text = preview.text.trim();
  const headline = preview.headline.trim();
  if (text && text !== headline) return text;
  if (headline) return headline;
  const blurbs = preview.workers
    .filter((w) => w.status !== "pending" && w.summary)
    .map((w) => `${w.role}：${w.summary}`);
  return blurbs.join(" · ");
}
