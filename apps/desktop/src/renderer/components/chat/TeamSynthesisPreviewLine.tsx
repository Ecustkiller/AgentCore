import {
  captainSynthesisPreviewText,
  isTeamSynthesizing,
  teamSynthesisPhaseLabel,
} from "@/components/chat/teamSynthesisPhase";
import { Badge } from "@/components/ui";
import { type Execution, useActiveExecField } from "@/stores/execution";
import { Loader2 } from "lucide-react";

/**
 * CEO 协调模式：多 worker 进展 / 合成草稿预览（transport-only）。
 * 汇总空窗（工人全完成、终稿/方案卡未到）即使用户侧无新 preview 事件，
 * 也渲染确定性「N/N 已完成，正在生成汇总」+ 活性指示，避免误判卡死。
 * 正文不走 content_delta / CEO 气泡。
 */
export function TeamSynthesisPreviewLine({
  execution,
}: {
  execution: Execution;
}) {
  const preview = useActiveExecField((rt) => rt.teamSynthesisPreview);
  const synthesizing = isTeamSynthesizing(execution);
  if (!preview && !synthesizing) return null;

  // 汇总空窗：preview 可能仍停在 N-1；用 execution 完成态补全 blurbs，避免「已 2/2」却只见 1 人摘要。
  const blurbs = synthesizing
    ? execution.runs
        .filter(
          (r) =>
            r.kind !== "captain" &&
            r.status === "completed" &&
            !!r.outputSummary,
        )
        .map((r) => ({
          run_id: r.id,
          role:
            execution.agents.find((a) => a.id === r.agentId)?.role ?? r.id,
          summary: r.outputSummary as string,
        }))
    : (preview?.workers.filter(
        (w) => w.status !== "pending" && w.summary,
      ) ?? []);
  const phaseLabel = synthesizing ? teamSynthesisPhaseLabel(execution) : "";
  const headline = synthesizing
    ? phaseLabel
    : (preview?.headline ?? "");
  const badge = synthesizing
    ? "生成汇总"
    : preview?.in_progress
      ? "进展中"
      : "团队进展";

  // update_synthesis：workers=[]、text=草稿；进展路径：有 blurbs 时不重复贴 text。
  let draftBody: string | null = null;
  if (preview) {
    if (blurbs.length === 0) {
      const text = preview.text.trim();
      const h = preview.headline.trim();
      if (text && text !== h && text !== phaseLabel) draftBody = text;
    } else if (synthesizing) {
      // 空窗期：在确定性标题下再挂一截已有草稿（若有且不同于 headline / blurbs）。
      const hint = captainSynthesisPreviewText(preview);
      if (
        hint &&
        hint !== phaseLabel &&
        hint !== preview.headline.trim() &&
        !blurbs.some((w) => hint.includes(w.summary))
      ) {
        draftBody = hint;
      }
    }
  }

  return (
    <div
      className={`mt-2 rounded-lg px-3 py-2 text-xs text-muted-foreground ${
        synthesizing
          ? "border border-primary/25 bg-primary/5"
          : "bg-muted/60"
      }`}
      data-testid="team-synthesis-preview"
      data-synthesizing={synthesizing ? "true" : "false"}
    >
      <div className="flex items-center gap-2">
        {synthesizing ? (
          <Loader2
            size={13}
            className="shrink-0 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden
          />
        ) : null}
        <Badge tone="primary" pill className="font-medium">
          {badge}
        </Badge>
        <span
          className={`min-w-0 flex-1 truncate font-medium ${
            synthesizing ? "text-primary" : "text-foreground"
          }`}
          data-testid="team-synthesis-headline"
        >
          {headline}
        </span>
        {synthesizing ? (
          <span
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
            aria-hidden
            data-testid="team-synthesis-pulse"
          />
        ) : null}
      </div>
      {blurbs.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 pl-0.5">
          {blurbs.map((w) => (
            <li key={w.run_id} className="truncate">
              · {w.role}：{w.summary}
            </li>
          ))}
        </ul>
      )}
      {draftBody && (
        <p
          className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-foreground/80"
          data-testid="team-synthesis-draft"
        >
          {draftBody}
        </p>
      )}
    </div>
  );
}
