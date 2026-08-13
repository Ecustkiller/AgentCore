import { Button } from "@/components/ui";
import { statusPillSoft } from "@/components/ui/tone-presets";
import type { FileAuditState } from "@/hooks/useFileAudit";
import { formatMessageTimeOfDay } from "@/lib/format";
import type { AgentAuditEvent } from "@/services/audit";
import { useMessageExecution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import type {
  AuditActorKind,
  AuditOutcome,
} from "@agentcore/contract-rest-types/audit";
import { ChevronRight, History, Loader2 } from "lucide-react";

const OUTCOME_META: Record<AuditOutcome, { label: string; className: string }> =
  {
    ok: { label: "成功", className: statusPillSoft.success },
    denied: { label: "已拒绝", className: statusPillSoft.muted },
    failed: { label: "失败", className: statusPillSoft.destructive },
    skipped: { label: "已跳过", className: statusPillSoft.muted },
  };

/**
 * 内部动作串 → 用户面动作词。
 *
 * 用户点进这条链问的是「这个文件是谁改的、改成功没有」，`tool.file_write` / `ok` 只会让他
 * 觉得这功能不是给他看的。审批 / 权限类动作自带结果语义（你批准了 / 被占用），结果徽章由
 * {@link outcomeShown} 抑制，避免「你批准了 · 成功」这种叠字。
 */
const ACTION_LABEL: Record<string, string> = {
  "tool.file_write": "写入",
  "tool.str_replace": "修改",
  "tool.file_read": "读取",
  "tool.file_delete": "删除",
  "tool.file_move": "移动",
  "tool.git": "版本管理",
  "permission.write_conflict": "另一名队员正占用写权",
  "approval.granted": "你批准了这次操作",
  "approval.denied": "你拒绝了这次操作",
  "approval.timeout": "等你批准超时",
};

/** 认不出的动作（后端新增）按类别退化成诚实的词，绝不把 `tool.xxx` 摆给用户。 */
function actionLabel(action: string): string {
  const known = ACTION_LABEL[action];
  if (known) return known;
  if (action.startsWith("approval.")) return "你的处置";
  if (action.startsWith("permission.")) return "权限拦截";
  return "文件操作";
}

function outcomeShown(action: string): boolean {
  return action.startsWith("tool.");
}

/** 没有协作图可查时的兜底称呼（协作图上的角色名优先）。 */
const ACTOR_LABEL: Record<AuditActorKind, string> = {
  captain: "主管",
  member: "队员",
  system: "系统",
};

/**
 * 「谁写的」——协作图上那个角色名。
 *
 * 审计行只带 run_id，用户对不上；按这一轮（`turn_id` 即该条助理消息）的协作图翻成角色名，
 * 翻不出来（历史回合的图未载入）就退回「主管 / 队员 / 系统」——仍是用户读得懂的词，绝不摆
 * 截断的 run id。
 */
function useActorName(event: AgentAuditEvent): string {
  const execution = useMessageExecution(event.run_id ? event.turn_id : null);
  const run = event.run_id
    ? execution?.runs.find((r) => r.id === event.run_id)
    : null;
  const role = run
    ? (execution?.agents.find((a) => a.id === run.agentId)?.role ?? run.role)
    : null;
  return role?.trim() || ACTOR_LABEL[event.actor_kind] || ACTOR_LABEL.system;
}

function FileAuditEventRow({ event }: { event: AgentAuditEvent }) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const outcome = OUTCOME_META[event.outcome] ?? OUTCOME_META.ok;
  const label = actionLabel(event.action);
  const actor = useActorName(event);
  const canNavigate = event.run_id != null && event.turn_id.length > 0;

  return (
    <div className="flex items-start gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs">
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatMessageTimeOfDay(event.created_at)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-foreground">{label}</span>
          {outcomeShown(event.action) && (
            <span className={`rounded-full px-1.5 py-0.5 ${outcome.className}`}>
              {outcome.label}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-muted-foreground">
          {actor}
        </span>
      </span>
      {canNavigate && (
        <Button
          variant="ghost"
          className="h-6 shrink-0 px-1.5 text-primary hover:bg-primary/10"
          onClick={() => {
            const runId = event.run_id;
            if (!runId) return;
            showRunDetail(event.turn_id, runId, actor);
          }}
        >
          <span className="flex items-center gap-0.5">
            详情
            <ChevronRight size={12} />
          </span>
        </Button>
      )}
    </div>
  );
}

/**
 * 文件写入归因链：什么时候、做了什么、成没成、谁做的——可跳转该队员的详情 tab。
 */
export function FileAuditTrail({
  state,
  compact,
}: {
  state: FileAuditState;
  compact?: boolean;
}) {
  if (state.status === "idle" || state.status === "empty") {
    return (
      <p className="text-xs text-muted-foreground">
        {compact ? "暂无写入记录" : "暂无归因记录"}
      </p>
    );
  }

  if (state.status === "loading") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" />
        加载中…
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {state.events.map((ev) => (
        <FileAuditEventRow key={ev.id} event={ev} />
      ))}
    </div>
  );
}

/** 带标题的归因区块（工作区预览 / 产物卡展开用）。 */
export function FileAuditSection({
  state,
  title = "写入归因",
}: {
  state: FileAuditState;
  title?: string;
}) {
  return (
    <section className="border-t border-border px-3 py-2.5">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <History size={12} />
        {title}
      </p>
      <FileAuditTrail state={state} />
    </section>
  );
}
