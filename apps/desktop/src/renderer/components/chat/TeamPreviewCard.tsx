import { shouldHostPreviewInGraph } from "@/components/chat/debatePreviewPlacement";
import { DecisionCard, DecisionCardIcon } from "@/components/ui";
import { useConversations } from "@/hooks/useConversations";
import { PERMISSION_PRESET_LABELS } from "@/services/permissionPreset";
import type { TeamPreviewDisplay } from "@/stores/conversation";
import { useConversationStore } from "@/stores/conversation";
import { usePersistentDisclosure } from "@/stores/disclosure";
import { useMessageExecution } from "@/stores/execution";
import type { SidecarPermissionPreset } from "@shared/sidecar-contract";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  OctagonX,
  Pencil,
  Scale,
  Shield,
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
 *
 * Resolved + team already started: content hosts in {@link GraphTeamPreview}
 * inside InlineTeamGraph (see {@link shouldHostPreviewInGraph}); this card
 * returns null so the timeline does not keep a spare card slot.
 */
export function TeamPreviewCard({
  preview,
  messageId,
}: {
  preview: TeamPreviewDisplay;
  /** Assistant message id — used to gate resolved embed into the graph. */
  messageId?: string;
}) {
  const execution = useMessageExecution(messageId ?? null);
  if (shouldHostPreviewInGraph(preview, execution?.runs)) {
    return null;
  }
  if (preview.status === "resolved") {
    return <ResolvedTeamPreview preview={preview} />;
  }
  return <DormantTeamPreview preview={preview} />;
}

const RESOLVED_META_DELEGATE = {
  continue: { icon: <Check size={14} />, label: "已授权开工 · 首波已放行" },
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

const RESOLVED_CONTINUE_WITH_NOTE = {
  icon: <Check size={14} />,
  label: "已授权开工 · 嘱咐已注入队员",
} as const;

const RESOLVED_DEBATE_CONTINUE_WITH_NOTE = {
  icon: <Check size={14} />,
  label: "已授权开赛 · 嘱咐已注入",
} as const;

const RESOLVED_META_DEBATE = {
  continue: { icon: <Check size={14} />, label: "已授权开赛 · 辩论已放行" },
  // 历史 adjust 消息保留原渲染文案（旧「改辩题」语义）；新路径不再发 adjust。
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

export function WorkerRows({ preview }: { preview: TeamPreviewDisplay }) {
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

/** Debate motion / round budget / sides — shared by standalone card and graph header. */
export function DebateBody({ preview }: { preview: TeamPreviewDisplay }) {
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

function graphPreviewSummary(preview: TeamPreviewDisplay): string {
  if (isDebate(preview)) {
    const n = preview.sides.length;
    return n > 0 ? `辩题 · ${n} 方` : "辩题";
  }
  const n = preview.workers.length;
  return n > 0 ? `分工 · ${n} 名队员` : "分工";
}

/**
 * Light collapsible block for InlineTeamGraph header — no DecisionCard shell.
 * Debate → 辩题 / DebateBody; delegate → 分工 / WorkerRows. Default collapsed;
 * expand reveals body + resolved note.
 */
export function GraphTeamPreview({
  preview,
}: {
  preview: TeamPreviewDisplay;
}) {
  const [open, setOpen] = usePersistentDisclosure(
    `team-preview-graph:${preview.id}`,
    false,
  );
  const summary = graphPreviewSummary(preview);

  return (
    <div
      className="border-t border-border px-4 py-2"
      data-testid="graph-team-preview"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <span className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
          {summary}
        </span>
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <>
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
        </>
      )}
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
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const conversations = useConversations();
  const permissionPreset: SidecarPermissionPreset = conversationId
    ? (conversations.find((c) => c.id === conversationId)?.permissionPreset ??
      "workspace")
    : "workspace";

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
          <p className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Shield size={11} />
            当前权限：{PERMISSION_PRESET_LABELS[permissionPreset].short}
            {permissionPreset === "full_trust"
              ? "（AI 将与你同权执行命令）"
              : ""}
          </p>
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
  const decision = preview.decision ?? "timeout";
  const metaTable = isDebate(preview)
    ? RESOLVED_META_DEBATE
    : RESOLVED_META_DELEGATE;
  // Historical `per_call` resolves collapse to continue copy (UI no longer offers it).
  const resolvedKey = decision === "per_call" ? "continue" : decision;
  const meta =
    decision === "continue" && Boolean(preview.note?.trim())
      ? isDebate(preview)
        ? RESOLVED_DEBATE_CONTINUE_WITH_NOTE
        : RESOLVED_CONTINUE_WITH_NOTE
      : (metaTable[resolvedKey as keyof typeof metaTable] ??
        metaTable.continue);
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
