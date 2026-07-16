import { statusPillSoft } from "@/components/ui/tone-presets";
import type { TurnAuditState } from "@/hooks/useTurnAudit";
import { formatMessageTimeOfDay } from "@/lib/format";
import type { AgentAuditEvent } from "@/services/audit";
import { PERMISSION_PRESET_LABELS } from "@/services/permissionPreset";
import type { AuditOutcome } from "@agentcore/contract-rest-types/audit";
import type { SidecarPermissionPreset } from "@shared/sidecar-contract";
import { Shield } from "lucide-react";

export type { AgentAuditEvent };

const OUTCOME_META: Record<AuditOutcome, { label: string; className: string }> =
  {
    ok: { label: "ok", className: statusPillSoft.success },
    denied: { label: "denied", className: statusPillSoft.muted },
    failed: { label: "failed", className: statusPillSoft.destructive },
    skipped: { label: "skipped", className: statusPillSoft.muted },
  };

const PRESET_KEYS = new Set(["observe", "workspace", "full_trust"]);

function presetLabel(raw: unknown): string | null {
  if (typeof raw !== "string" || !PRESET_KEYS.has(raw)) return null;
  return PERMISSION_PRESET_LABELS[raw as SidecarPermissionPreset].short;
}

function actionLabel(event: AgentAuditEvent): string {
  const tool = event.detail?.tool_name;
  if (event.category === "approval" && typeof tool === "string") {
    const who =
      event.detail?.decided_by === "user"
        ? "你"
        : event.detail?.decided_by === "timeout"
          ? "超时"
          : "系统";
    if (event.action === "approval.denied") return `${who}拒绝了 ${tool}`;
    if (event.action === "approval.timeout") return `审批超时 · ${tool}`;
    return `${who}批准了 ${tool}`;
  }
  if (event.action === "permission.preset_changed") {
    const from =
      presetLabel(event.detail?.previous) ??
      String(event.detail?.previous ?? "?");
    const to =
      presetLabel(event.detail?.permission_preset) ??
      String(event.detail?.permission_preset ?? "?");
    return `权限模式 ${from} → ${to}`;
  }
  if (event.action === "permission.preset_snapshot") {
    const p =
      presetLabel(event.detail?.permission_preset) ??
      String(event.detail?.permission_preset ?? "?");
    return `本回合模式 · ${p}`;
  }
  if (
    event.category === "tool" &&
    event.target_type === "file" &&
    event.target_ref
  ) {
    return `写入 ${event.target_ref}`;
  }
  if (event.action.startsWith("tool.")) {
    return `执行 ${event.action.slice(5)}`;
  }
  return event.action;
}

export type SecurityLedgerBuckets = {
  writes: AgentAuditEvent[];
  runs: AgentAuditEvent[];
  approvals: AgentAuditEvent[];
  presets: AgentAuditEvent[];
  presetInForce: string | null;
};

/** Aggregate turn (or conversation) audit rows for the security ledger. */
export function bucketSecurityLedger(
  events: AgentAuditEvent[] | null | undefined,
): SecurityLedgerBuckets {
  const writes: AgentAuditEvent[] = [];
  const runs: AgentAuditEvent[] = [];
  const approvals: AgentAuditEvent[] = [];
  const presets: AgentAuditEvent[] = [];
  let presetInForce: string | null = null;

  for (const e of events ?? []) {
    if (
      e.action === "permission.preset_snapshot" ||
      e.action === "permission.preset_changed"
    ) {
      presets.push(e);
      const p = e.detail?.permission_preset;
      if (typeof p === "string") presetInForce = p;
      continue;
    }
    if (e.category === "approval") {
      approvals.push(e);
      continue;
    }
    if (e.category === "tool") {
      if (
        e.action === "tool.code_execute" ||
        e.action === "tool.test_run" ||
        e.action === "tool.terminal"
      ) {
        runs.push(e);
      } else if (
        e.target_type === "file" ||
        e.action.startsWith("tool.file_")
      ) {
        writes.push(e);
      } else if (e.action === "tool.git" || e.action === "tool.str_replace") {
        writes.push(e);
      } else {
        runs.push(e);
      }
    }
  }

  return { writes, runs, approvals, presets, presetInForce };
}

function LedgerGroup({
  title,
  events,
}: {
  title: string;
  events: AgentAuditEvent[];
}) {
  if (events.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="space-y-1">
        {events.map((e) => {
          const outcome = OUTCOME_META[e.outcome] ?? OUTCOME_META.ok;
          return (
            <li
              key={e.id}
              className="flex items-start gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs"
            >
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatMessageTimeOfDay(e.created_at)}
              </span>
              <span className="min-w-0 flex-1 text-foreground">
                {actionLabel(e)}
              </span>
              <span
                className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono ${outcome.className}`}
              >
                {outcome.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 会话安全台账：写了什么 / 跑了什么 / 谁批的 / 当时 permission_preset。
 * 数据面复用 useTurnAudit（或传入已聚合的 events）。
 */
export function TurnSecurityLedger({
  state,
  events,
  compact,
}: {
  state?: TurnAuditState;
  events?: AgentAuditEvent[] | null;
  compact?: boolean;
}) {
  const loading = state?.loading ?? false;
  const error = state?.error ?? null;
  const rows = events ?? state?.data?.data ?? null;
  const buckets = bucketSecurityLedger(rows);
  const total =
    buckets.writes.length +
    buckets.runs.length +
    buckets.approvals.length +
    buckets.presets.length;

  if (loading && total === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {compact ? "加载台账…" : "正在加载安全台账…"}
      </p>
    );
  }
  if (error && total === 0) {
    return <p className="text-xs text-muted-foreground">{error}</p>;
  }
  if (total === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {compact ? "本回合暂无审计" : "本回合暂无安全审计记录"}
      </p>
    );
  }

  const presetChip = buckets.presetInForce
    ? (presetLabel(buckets.presetInForce) ?? buckets.presetInForce)
    : null;

  return (
    <div className="space-y-3">
      {!compact && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Shield size={13} className="shrink-0" />
          <span>安全台账</span>
          {presetChip && (
            <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">
              {presetChip}
            </span>
          )}
        </div>
      )}
      <LedgerGroup title="权限模式" events={buckets.presets} />
      <LedgerGroup title="写入" events={buckets.writes} />
      <LedgerGroup title="执行" events={buckets.runs} />
      <LedgerGroup title="审批" events={buckets.approvals} />
    </div>
  );
}
