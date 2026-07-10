import { DecisionCard, DecisionCardIcon } from "@/components/ui";
import type { TeamPreviewDisplay } from "@/stores/conversation";
import { Check, Clock, OctagonX, Pencil, Users } from "lucide-react";

/**
 * Inline team_preview card — thin preflight before the first worker wave starts.
 * Actionable surface is the durable ResumePrompt (挂起即收口); inline is a passive
 * record (dormant pending / resolved), same posture as PlanReviewCard.
 */
export function TeamPreviewCard({ preview }: { preview: TeamPreviewDisplay }) {
  if (preview.status === "resolved") {
    return <ResolvedTeamPreview preview={preview} />;
  }
  return <DormantTeamPreview preview={preview} />;
}

function WorkerRows({ preview }: { preview: TeamPreviewDisplay }) {
  return (
    <div className="mt-2 space-y-1.5">
      {preview.workers.map((w) => (
        <div
          key={w.run_id}
          className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-xs font-medium text-foreground">{w.role}</p>
            {w.debate && (
              <span className="text-xs text-muted-foreground">辩论</span>
            )}
            {w.depends_on.length > 0 && (
              <span className="text-xs text-muted-foreground">
                依赖 {w.depends_on.length} 步
              </span>
            )}
          </div>
          {w.task && (
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
              {w.task}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function DormantTeamPreview({ preview }: { preview: TeamPreviewDisplay }) {
  return (
    <DecisionCard tone="neutral">
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="neutral">
          <Users size={16} />
        </DecisionCardIcon>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">
            曾在此预览过团队（本回合已结束）
          </p>
          <WorkerRows preview={preview} />
        </div>
      </div>
    </DecisionCard>
  );
}

function ResolvedTeamPreview({ preview }: { preview: TeamPreviewDisplay }) {
  const meta = {
    continue: { icon: <Check size={14} />, label: "已开做 · 首波已放行" },
    adjust: {
      icon: <Pencil size={14} />,
      label: "已调整 · 备注已注入队员并开做",
    },
    stop: { icon: <OctagonX size={14} />, label: "已停止 · 团队未启动" },
    timeout: { icon: <Clock size={14} />, label: "未及时回应，已自动开做" },
  }[preview.decision ?? "timeout"];

  return (
    <DecisionCard tone="neutral" className="bg-card/60">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-muted-foreground">{meta.icon}</span>
        <div className="min-w-0 flex-1">
          <WorkerRows preview={preview} />
          <p className="mt-1.5 text-xs font-medium text-muted-foreground">
            {meta.label}
          </p>
          {preview.note && (
            <p className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-foreground">
              {preview.note}
            </p>
          )}
        </div>
      </div>
    </DecisionCard>
  );
}
