import { Button } from "@/components/ui";
import { formatMessageTimeOfDay } from "@/lib/format";
import { isWebPreview } from "@/lib/preview";
import { type AgentAuditEvent, fetchTurnAudit } from "@/services/audit";
import { usePersistentDisclosure } from "@/stores/disclosure";
import type {
  AuditCategory,
  AuditOutcome,
} from "@agentcore/contract-rest-types/audit";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Lock,
  MessageSquare,
  Radio,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Section } from "./shared";

const CATEGORY_META: Record<
  AuditCategory,
  { label: string; icon: typeof Wrench; tone: string }
> = {
  orchestration: {
    label: "编排",
    icon: GitBranch,
    tone: "text-primary",
  },
  tool: { label: "工具", icon: Wrench, tone: "text-foreground" },
  approval: {
    label: "审批",
    icon: CheckCircle2,
    tone: "text-warning",
  },
  comm: { label: "通信", icon: MessageSquare, tone: "text-foreground" },
  state: { label: "状态", icon: Radio, tone: "text-muted-foreground" },
  failure: {
    label: "失败",
    icon: AlertTriangle,
    tone: "text-destructive",
  },
  permission: { label: "权限", icon: Lock, tone: "text-muted-foreground" },
};

const OUTCOME_META: Record<AuditOutcome, { label: string; className: string }> =
  {
    ok: { label: "ok", className: "bg-success/10 text-success" },
    denied: { label: "denied", className: "bg-warning/10 text-warning" },
    failed: {
      label: "failed",
      className: "bg-destructive/10 text-destructive",
    },
    skipped: { label: "skipped", className: "bg-muted text-muted-foreground" },
  };

function detailPeek(detail: Record<string, unknown>): string | null {
  const keys = Object.keys(detail);
  if (keys.length === 0) return null;
  const preview = keys.slice(0, 3).map((k) => {
    const v = detail[k];
    if (typeof v === "string") {
      return v.length > 40 ? `${k}: ${v.slice(0, 40)}…` : `${k}: ${v}`;
    }
    if (typeof v === "number" || typeof v === "boolean") return `${k}: ${v}`;
    if (Array.isArray(v)) return `${k}: [${v.length}]`;
    return k;
  });
  return preview.join(" · ");
}

function AuditEventRow({
  event,
  keyBase,
}: {
  event: AgentAuditEvent;
  keyBase: string;
}) {
  const [open, setOpen] = usePersistentDisclosure(
    `${keyBase}:audit:${event.id}`,
    false,
  );
  const meta = CATEGORY_META[event.category] ?? CATEGORY_META.state;
  const Icon = meta.icon;
  const outcome = OUTCOME_META[event.outcome] ?? OUTCOME_META.ok;
  const peek = detailPeek(event.detail);
  const hasDetail = peek != null || Object.keys(event.detail).length > 0;

  return (
    <div className="rounded-lg bg-muted px-2.5 py-1.5 text-xs">
      <Button
        variant="ghost"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`h-auto w-full justify-start gap-2 px-0 py-0 hover:bg-transparent ${
          hasDetail ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="flex w-full items-start gap-2 text-left">
          <Icon size={12} className={`mt-0.5 shrink-0 ${meta.tone}`} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="tabular-nums text-muted-foreground">
                {formatMessageTimeOfDay(event.created_at)}
              </span>
              <span className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-foreground">
                {event.action}
              </span>
              <span
                className={`rounded-full px-1.5 py-0.5 font-mono ${outcome.className}`}
              >
                {outcome.label}
              </span>
            </span>
            {event.target_ref && (
              <span className="mt-0.5 block truncate font-mono text-muted-foreground">
                {event.target_ref}
              </span>
            )}
            {hasDetail && !open && peek && (
              <span className="mt-0.5 block truncate text-muted-foreground/80">
                {peek}
              </span>
            )}
          </span>
          {hasDetail &&
            (open ? (
              <ChevronDown
                size={12}
                className="shrink-0 text-muted-foreground"
              />
            ) : (
              <ChevronRight
                size={12}
                className="shrink-0 text-muted-foreground"
              />
            ))}
        </span>
      </Button>
      {open && hasDetail && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/50 p-2 font-mono text-xs text-muted-foreground">
          {JSON.stringify(event.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}

/**
 * Run 详情「活动记录」：按时间排列的审计事件子时间线（编排 / 副作用 / 审批等）。
 * 数据来自 owner-scoped `GET …/audit`，客户端按 run_id 过滤，与 GraphView 结构视图互补。
 */
export function AuditSection({
  conversationId,
  messageId,
  runId,
}: {
  conversationId: string;
  messageId: string;
  runId: string;
}) {
  const [events, setEvents] = useState<AgentAuditEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const keyBase = `run:${runId}`;
  const preview = isWebPreview();

  useEffect(() => {
    if (preview) {
      setEvents([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchTurnAudit(conversationId, messageId)
      .then((res) => {
        if (!cancelled) {
          setEvents(res.data.filter((ev) => ev.run_id === runId));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEvents([]);
          setError("加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, messageId, runId, preview]);

  if (preview) {
    return (
      <Section title="活动记录">
        <p className="text-xs text-muted-foreground">暂无审计记录</p>
      </Section>
    );
  }

  if (loading) {
    return (
      <Section title="活动记录">
        <p className="text-xs text-muted-foreground">加载中…</p>
      </Section>
    );
  }

  if (error) {
    return (
      <Section title="活动记录">
        <p className="text-xs text-muted-foreground">{error}</p>
      </Section>
    );
  }

  if (!events || events.length === 0) {
    return (
      <Section title="活动记录">
        <p className="text-xs text-muted-foreground">暂无审计记录</p>
      </Section>
    );
  }

  return (
    <Section title="活动记录">
      <div className="space-y-1.5">
        {events.map((ev) => (
          <AuditEventRow key={ev.id} event={ev} keyBase={keyBase} />
        ))}
      </div>
    </Section>
  );
}
