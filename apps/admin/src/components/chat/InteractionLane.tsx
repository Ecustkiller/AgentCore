import { Badge } from "@/components/ui/Badge";
import type { NormalizedInteraction } from "@/components/chat/chatTurn";

const KIND_LABEL: Record<string, string> = {
  approval: "审批",
  ask_user: "提问",
  plan_review: "计划复核",
  team_preview: "开工卡",
  delegation_authorization: "委派授权",
  escalation: "升级",
  question_posted: "提问",
  stage_card: "推进卡",
};

const STATUS_TONE: Record<
  string,
  "neutral" | "primary" | "success" | "warning" | "destructive"
> = {
  pending: "warning",
  resolved: "success",
  orphaned: "neutral",
};

/**
 * Degraded interaction chips: kind + status only.
 * Approval resolved does not say 通过/拒绝 — decision is not on the projection.
 */
export function InteractionLane({
  interactions,
}: {
  interactions: NormalizedInteraction[];
}) {
  if (interactions.length === 0) return null;
  return (
    <ul aria-label="交互" className="flex flex-wrap gap-2">
      {interactions.map((i, index) => (
        <li
          key={i.id || `${i.kind}-${index}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1 text-xs"
        >
          <span className="font-medium text-foreground">
            {KIND_LABEL[i.kind] ?? i.kind}
          </span>
          {i.status && (
            <Badge tone={STATUS_TONE[i.status] ?? "neutral"}>{i.status}</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}
