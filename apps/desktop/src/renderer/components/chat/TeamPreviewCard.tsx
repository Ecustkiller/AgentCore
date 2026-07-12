import { DecisionCard, DecisionCardIcon } from "@/components/ui";
import type { TeamPreviewDisplay } from "@/stores/conversation";
import { usePersistentDisclosure } from "@/stores/disclosure";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  OctagonX,
  Pencil,
  Scale,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * Inline team_preview card — thin preflight before fan-out / moderator start.
 * Actionable surface is the durable ResumePrompt (挂起即收口); inline pending is a
 * passive「等待确认」record (resolved shows the settled decision), same posture as
 * PlanReviewCard.
 *
 * Defaults collapsed to a one-line conclusion; expand for plan details + note.
 * Branches on ``primitive``: delegate = 队员分工表; debate = 辩题 / 立场 / 轮次预算.
 */
export function TeamPreviewCard({ preview }: { preview: TeamPreviewDisplay }) {
  if (preview.status === "resolved") {
    return <ResolvedTeamPreview preview={preview} />;
  }
  return <DormantTeamPreview preview={preview} />;
}

const RESOLVED_META_DELEGATE = {
  continue: { icon: <Check size={14} />, label: "已授权开工 · 首波已放行" },
  per_call: {
    icon: <Check size={14} />,
    label: "已开工 · 将逐次审批能力调用",
  },
  adjust: {
    icon: <Pencil size={14} />,
    label: "已调整 · 备注已注入队员并开做",
  },
  stop: { icon: <OctagonX size={14} />, label: "已停止 · 团队未启动" },
  timeout: { icon: <Clock size={14} />, label: "未及时回应，已自动开做" },
  orphaned: {
    icon: <Ban size={14} />,
    label: "已失效（回合已结束或服务已重启）",
  },
} as const;

const RESOLVED_META_DEBATE = {
  continue: { icon: <Check size={14} />, label: "已授权开赛 · 辩论已放行" },
  per_call: {
    icon: <Check size={14} />,
    label: "已开赛",
  },
  adjust: {
    icon: <Pencil size={14} />,
    label: "已调整辩题 · 开赛",
  },
  stop: { icon: <OctagonX size={14} />, label: "已停止 · 辩论未开赛" },
  timeout: { icon: <Clock size={14} />, label: "未及时回应，已自动开赛" },
  orphaned: {
    icon: <Ban size={14} />,
    label: "已失效（回合已结束或服务已重启）",
  },
} as const;

function isDebate(preview: TeamPreviewDisplay): boolean {
  return preview.primitive === "debate";
}

function summarySuffix(preview: TeamPreviewDisplay): string {
  if (isDebate(preview)) {
    const n = preview.sides.length;
    return n > 0 ? `${n} 方` : "辩论";
  }
  return `${preview.workers.length} 名队员`;
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

function DebateBody({ preview }: { preview: TeamPreviewDisplay }) {
  const budget =
    preview.maxRounds > 0
      ? preview.thorough
        ? `认真辩透 · 上限 ${preview.maxRounds} 轮`
        : `快速对碰 · ${preview.maxRounds} 轮`
      : preview.thorough
        ? "认真辩透"
        : "快速对碰";

  return (
    <div className="mt-2 space-y-1.5">
      {preview.motion && (
        <p className="whitespace-pre-wrap text-xs text-foreground">
          {preview.motion}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{budget}</p>
      {preview.sides.map((s) => (
        <div
          key={s.key}
          className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-xs font-medium text-foreground">{s.name}</p>
            {s.is_subject && (
              <span className="text-xs text-muted-foreground">方案方</span>
            )}
          </div>
          {s.stance && (
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
              {s.stance}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function CollapsibleBody({
  disclosureKey,
  summary,
  children,
}: {
  disclosureKey: string;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = usePersistentDisclosure(disclosureKey, false);

  return (
    <div className="min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-1.5 text-left"
      >
        <span className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
          {summary}
        </span>
        {open ? (
          <ChevronDown
            size={14}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
        ) : (
          <ChevronRight
            size={14}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
        )}
      </button>
      {open && children}
    </div>
  );
}

function DormantTeamPreview({ preview }: { preview: TeamPreviewDisplay }) {
  const summary = `等待开工确认 · ${summarySuffix(preview)}`;
  const Icon = isDebate(preview) ? Scale : Users;

  return (
    <DecisionCard tone="neutral">
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="neutral">
          <Icon size={16} />
        </DecisionCardIcon>
        <CollapsibleBody
          disclosureKey={`team-preview:${preview.id}`}
          summary={summary}
        >
          {isDebate(preview) ? (
            <DebateBody preview={preview} />
          ) : (
            <WorkerRows preview={preview} />
          )}
        </CollapsibleBody>
      </div>
    </DecisionCard>
  );
}

function ResolvedTeamPreview({ preview }: { preview: TeamPreviewDisplay }) {
  const metaTable = isDebate(preview)
    ? RESOLVED_META_DEBATE
    : RESOLVED_META_DELEGATE;
  const meta = metaTable[preview.decision ?? "timeout"];
  const summary = `${meta.label} · ${summarySuffix(preview)}`;

  return (
    <DecisionCard tone="neutral" className="bg-card/60">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {meta.icon}
        </span>
        <CollapsibleBody
          disclosureKey={`team-preview:${preview.id}`}
          summary={summary}
        >
          {isDebate(preview) ? (
            <DebateBody preview={preview} />
          ) : (
            <WorkerRows preview={preview} />
          )}
          {preview.note && (
            <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-foreground">
              {preview.note}
            </p>
          )}
        </CollapsibleBody>
      </div>
    </DecisionCard>
  );
}
