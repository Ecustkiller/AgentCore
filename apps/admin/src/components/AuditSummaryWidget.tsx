import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Page";
import {
  ErrorState,
  Refreshing,
  StaleDataNotice,
  TableSkeleton,
} from "@/components/ui/States";
import { cn, fmtInt } from "@/lib/utils";
import {
  type AdminAgentAuditSummary,
  fetchAgentAuditSummary,
} from "@/services/adminAgentAudit";
import { errorMessage } from "@/services/api";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * 观测看板审计聚合 widget：近 7 日失败事件、审批拒绝/超时、委派计划、采集降级。
 */
export function AuditSummaryWidget({ reloadKey = 0 }: { reloadKey?: number }) {
  const [data, setData] = useState<AdminAgentAuditSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchAgentAuditSummary());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  if (!data) {
    return loading ? (
      <TableSkeleton rows={4} columns={3} />
    ) : (
      <ErrorState message={error ?? "加载失败"} onRetry={() => void load()} />
    );
  }

  const approvalTotal = data.approval_denied + data.approval_timeouts;

  return (
    <Card>
      <SectionHeader
        title="Agent 审计 · 近 7 日"
        description={`多 Agent 协作副作用与审批健康（跨用户聚合，共 ${fmtInt(
          data.events,
        )} 条事件）`}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            aria-label="刷新审计"
          >
            <RefreshCw size={14} className={cn(loading && "animate-spin")} />
          </Button>
        }
      />
      <div className="p-5">
        {error && (
          <StaleDataNotice
            message={error}
            onRetry={() => void load()}
            className="mb-4"
          />
        )}
        <Refreshing active={loading}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <MetricTile
              label="失败事件"
              value={fmtInt(data.failures)}
              tone={data.failures === 0 ? "success" : "destructive"}
            />
            <MetricTile
              label="审批拒绝"
              value={fmtInt(data.approval_denied)}
              tone={data.approval_denied === 0 ? "success" : "warning"}
            />
            <MetricTile
              label="审批超时"
              value={fmtInt(data.approval_timeouts)}
              tone={data.approval_timeouts === 0 ? "success" : "warning"}
            />
          </div>

          {approvalTotal > 0 && (
            <p className="mt-4 text-muted-foreground text-xs">
              审批异常合计 {fmtInt(approvalTotal)}（拒绝 + 超时）
            </p>
          )}

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <MetricTile
              label="委派计划"
              value={fmtInt(data.delegate_plans)}
              tone="neutral"
            />
            <MetricTile
              label="审计采集丢失"
              value={fmtInt(data.audit_drops)}
              tone={data.audit_drops === 0 ? "success" : "warning"}
            />
          </div>
        </Refreshing>
      </div>
    </Card>
  );
}

type Tone = "success" | "warning" | "destructive" | "neutral";

/** 「无异常」是常态，所以 0 用中性色——只有红 / 黄才是要人看的信号。 */
const TILE_TONES: Record<Tone, string> = {
  destructive: "text-destructive",
  warning: "text-warning",
  success: "text-foreground",
  neutral: "text-foreground",
};

function MetricTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: Tone;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4">
      <div className="text-muted-foreground text-sm">{label}</div>
      <div
        className={cn("mt-1 text-2xl font-semibold tabular-nums", TILE_TONES[tone])}
      >
        {value}
      </div>
    </div>
  );
}
