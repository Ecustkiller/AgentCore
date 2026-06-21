import { Button, IconButton } from "@/components/ui";
import { Switch } from "@/components/ui/Switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { formatCompact, formatCost, formatUsd } from "@/lib/format";
import { useUIStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import { KeyRound, Loader2, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { SettingsHeader } from "./SettingsHeader";

/**
 * Account usage dashboard (§7.3D) — the manager's view of the team's spend.
 *
 * 大众面 leads with two semantic quota meters (本月额度 / 今日 tokens) so the user
 * reads「还剩多少」at a glance without big raw numbers. The page also hosts the one
 * global「用量明细 / Power 模式」switch (`usageDetail`, §7.1): turning it on reveals
 * the token / cost breakdown here AND defaults each run's「资源消耗」to expanded — a
 * single grain control instead of two. Money (¥) is never gated by it. All numbers
 * come from `GET /usage/summary` via the usage store; money formats off the single
 * server FX rate.
 */
export function UsageSettings() {
  const summary = useUsageStore((s) => s.summary);
  const loading = useUsageStore((s) => s.loading);
  const error = useUsageStore((s) => s.error);
  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const fetchSummary = useUsageStore((s) => s.fetchSummary);
  // The grain switch lives here but is global (§7.1): it also drives run-detail's
  // 资源消耗 default-expand, so it reads/writes the shared UI store, not local state.
  const usageDetail = useUIStore((s) => s.usageDetail);
  const setUsageDetail = useUIStore((s) => s.setUsageDetail);

  // Refresh on open: the bootstrap snapshot may be stale by the time the user
  // lands here. Best-effort (the store keeps the last value + a soft error).
  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  const refresh = () => void fetchSummary();
  // BYOK: platform quota is dormant (the turn runs on the user's own key), so the
  // page reframes额度 as「自带 Key 不限额」and presents cost as the user's own spend.
  const byok = summary?.billing_mode === "byok";

  return (
    <div>
      <SettingsHeader
        title="用量"
        description={
          byok
            ? "自带 Key 模式：对话按你的 DeepSeek 额度计费、平台不限额。下方为你的用量与花费，成本以人民币估算。"
            : "本月额度与今日用量。成本按团队角色拆分，以人民币展示。"
        }
        action={
          // Manual refresh once data exists — numbers go stale after running tasks
          // elsewhere (mount-only fetch otherwise). First load / first-load failure
          // are handled by the dedicated states below, so the button shows here.
          summary ? (
            <SimpleTooltip label="刷新">
              <IconButton
                size="md"
                aria-label="刷新"
                onClick={refresh}
                disabled={loading}
              >
                <RefreshCw
                  size={16}
                  className={loading ? "animate-spin" : undefined}
                />
              </IconButton>
            </SimpleTooltip>
          ) : undefined
        }
      />

      <PowerModeToggle enabled={usageDetail} onChange={setUsageDetail} />

      {/* 三态分离：已有数据（含刷新失败的软告警）/ 首屏失败 / 首屏加载中。 */}
      {summary ? (
        <>
          {error && <RefreshErrorBanner message={error} onRetry={refresh} />}
          <Dashboard
            summary={summary}
            cnyPerUsd={cnyPerUsd}
            showDetail={usageDetail}
            byok={byok}
          />
        </>
      ) : error ? (
        <ErrorState message={error} onRetry={refresh} />
      ) : (
        <LoadingState />
      )}
    </div>
  );
}

/** First-load spinner — distinct from the error state (P1: 加载/错误分离). */
function LoadingState() {
  return (
    <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 size={16} className="animate-spin" />
      加载中…
    </div>
  );
}

/** First-load failure: no data to show, so a prominent centered retry (P1). */
function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="mt-6 flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button onClick={onRetry}>重试</Button>
    </div>
  );
}

/**
 * Refresh failed but stale data exists: a soft amber banner above the dashboard
 * with an inline retry. 用量是附属呈现——刷新失败不清空已有数字 (P1)，只提示可能过期。
 */
function RefreshErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5">
      <p className="text-xs text-warning">{message}</p>
      <Button variant="neutral" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

/**
 * The single global「用量明细 / Power 模式」switch (§7.1). Off by default (大众);
 * on reveals technical breakdowns and defaults run-detail「资源消耗」to expanded.
 * 成本（¥）始终可见，不受它控制。
 */
function PowerModeToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="mt-6 flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground">用量明细（Power 模式）</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          显示 token、缓存率等技术明细，并默认展开各 Agent
          的资源消耗。成本（¥）始终可见。
        </p>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={onChange}
        label="用量明细（Power 模式）"
      />
    </div>
  );
}

type Summary = NonNullable<
  ReturnType<typeof useUsageStore.getState>["summary"]
>;

/**
 * BYOK reframe of the quota block: the platform额度 is dormant (the turn runs on
 * the user's own DeepSeek key), so instead of meters we explain that spend below
 * is the user's own estimated DeepSeek cost and there is no platform cap.
 */
function ByokNote() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 px-4 py-3">
      <KeyRound size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
      <p className="text-xs text-muted-foreground">
        当前为「自带 Key」模式：对话按你自己的 DeepSeek
        额度计费，平台不设上限。下方花费为按官方价格估算的你的 DeepSeek
        用量，可在「模型配置」中管理你的 Key。
      </p>
    </div>
  );
}

function Dashboard({
  summary,
  cnyPerUsd,
  showDetail,
  byok,
}: {
  summary: Summary;
  cnyPerUsd: number;
  showDetail: boolean;
  byok: boolean;
}) {
  const { today, month, quota } = summary;
  const monthLimit = quota.monthly_cost_nano;
  const monthUsed = month.cost.total;
  const dayTokenLimit = quota.daily_tokens;
  const dayTokensUsed = today.usage.input + today.usage.output;
  const dayReqLimit = quota.daily_requests;
  const dayReqUsed = today.requests;
  const monthNear = monthLimit > 0 && monthUsed / monthLimit >= 0.8;

  // Reset captions derive from the backend's UTC window boundaries (usage.py /
  // quota.py) rendered in local time — see resetTexts() for why.
  const { dailyResetText, monthlyResetText } = resetTexts();

  const moneyCaption =
    monthLimit > 0
      ? `已用 ${formatCost(monthUsed, cnyPerUsd)} / ${formatCost(monthLimit, cnyPerUsd)} · ${monthlyResetText}`
      : `已用 ${formatCost(monthUsed, cnyPerUsd)} · 不限`;
  const tokenCaption =
    dayTokenLimit > 0
      ? `${formatCompact(dayTokensUsed)} / ${formatCompact(dayTokenLimit)} · ${dailyResetText}`
      : `${formatCompact(dayTokensUsed)} · 不限`;
  const reqCaption =
    dayReqLimit > 0
      ? `${dayReqUsed} / ${dayReqLimit} 次 · ${dailyResetText}`
      : `${dayReqUsed} 次 · 不限`;

  return (
    <div className="mt-6 space-y-5">
      {byok ? (
        <ByokNote />
      ) : (
        <>
          <QuotaMeter
            label="本月额度"
            used={monthUsed}
            limit={monthLimit}
            caption={moneyCaption}
          />
          {monthNear && (
            <p className="-mt-3 text-xs text-warning">
              接近本月额度，超出将暂停服务。
            </p>
          )}
          <QuotaMeter
            label="今日 tokens"
            used={dayTokensUsed}
            limit={dayTokenLimit}
            caption={tokenCaption}
          />
          <QuotaMeter
            label="今日请求"
            used={dayReqUsed}
            limit={dayReqLimit}
            caption={reqCaption}
          />
        </>
      )}

      {/* 近 7 日成本趋势 (§7.3D) — ¥ over time, 大众-visible. Hidden when the whole
          window had no spend (a flat zero trend tells the user nothing). */}
      {summary.recent_daily_cost.some((p) => p.cost_total > 0) && (
        <CostTrend points={summary.recent_daily_cost} cnyPerUsd={cnyPerUsd} />
      )}

      {/* 本月各角色花销 (§7.3D, 团队工资单 by role) — ¥ is 大众-visible (§7.1),
          so this lands for everyone, not just Power. Empty until the month has spend. */}
      {summary.month_by_role.length > 0 && (
        <RolePayroll lines={summary.month_by_role} cnyPerUsd={cnyPerUsd} />
      )}

      {/* 明细 default-collapses; the global 用量明细 switch above reveals it (§7.1). */}
      {showDetail && <UsageDetail summary={summary} cnyPerUsd={cnyPerUsd} />}
    </div>
  );
}

/**
 * Reset captions for the quota meters, derived from the backend's UTC window
 * boundaries (usage.py / quota.py) and rendered in the user's LOCAL time.
 *
 * Daily windows reset at the next UTC midnight, the monthly window at the next UTC
 * month start — both the same instant-of-day in local time (the UTC offset). So the
 * daily caption is that recurring local time and the monthly caption is the local
 * date + that time. Building the date from the UTC boundary (not a local-midnight
 * `new Date(y, m+1, 1)`) is what fixes the prior reset label drifting by the offset
 * (per-user timezone windows are a later backend refinement).
 */
function resetTexts(): { dailyResetText: string; monthlyResetText: string } {
  const now = new Date();
  const dailyReset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const monthlyReset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  const pad = (n: number) => String(n).padStart(2, "0");
  const hhmm = `${pad(dailyReset.getHours())}:${pad(dailyReset.getMinutes())}`;
  return {
    dailyResetText: `每日 ${hhmm} 重置`,
    monthlyResetText: `${monthlyReset.getMonth() + 1} 月 ${monthlyReset.getDate()} 日 ${hhmm} 重置`,
  };
}

/** A semantic quota bar: % filled, amber past 80%, no bar when unlimited (§7.3D). */
function QuotaMeter({
  label,
  used,
  limit,
  caption,
}: {
  label: string;
  used: number;
  limit: number;
  caption: string;
}) {
  const unlimited = limit <= 0;
  const pct = unlimited ? 0 : Math.min(Math.round((used / limit) * 100), 100);
  const near = !unlimited && pct >= 80;

  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-foreground">{label}</span>
        <span className={near ? "text-warning" : "text-muted-foreground"}>
          {unlimited ? "不限" : `${pct}%`}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
        {!unlimited && (
          <div
            className={`h-full rounded-full ${near ? "bg-warning" : "bg-primary"}`}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}

/** Zh weekday for an ISO UTC date — read in UTC so the label matches the day key
 * (the backend buckets by UTC calendar day), tz-offset-proof. */
function weekdayLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return `周${["日", "一", "二", "三", "四", "五", "六"][d.getUTCDay()]}`;
}

/**
 * 近 7 日成本趋势 (§7.3D) — a compact daily-spend bar sparkline. Bars scale to the
 * window's max day; ¥ per day on hover. Money over time is 大众-visible (§7.1).
 */
function CostTrend({
  points,
  cnyPerUsd,
}: {
  points: Summary["recent_daily_cost"];
  cnyPerUsd: number;
}) {
  const max = points.reduce((m, p) => Math.max(m, p.cost_total), 0);
  const total = points.reduce((s, p) => s + p.cost_total, 0);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-foreground">近 7 日成本</p>
        <span className="text-xs text-muted-foreground">
          合计 {formatCost(total, cnyPerUsd)}
        </span>
      </div>
      <div className="mt-3 flex h-16 items-end gap-1.5">
        {points.map((p) => {
          // Min 2% so a zero / tiny day still shows a sliver baseline.
          const h = max > 0 ? Math.max((p.cost_total / max) * 100, 2) : 2;
          return (
            <SimpleTooltip
              key={p.date}
              label={`${weekdayLabel(p.date)} · ${formatCost(p.cost_total, cnyPerUsd)}`}
            >
              <div className="flex flex-1 flex-col items-center gap-1">
                <div className="flex w-full flex-1 items-end">
                  <div
                    className="w-full rounded-full bg-primary"
                    style={{ height: `${h}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {weekdayLabel(p.date)}
                </span>
              </div>
            </SimpleTooltip>
          );
        })}
      </div>
    </div>
  );
}

/** Ledger system roles → 大众-facing zh labels. Unknown roles fall back to raw. */
const ROLE_LABELS: Record<string, string> = {
  captain: "CEO",
  member: "队员",
  arena: "辩论",
  title: "标题生成",
  memory: "记忆整理",
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/**
 * 本月各角色花销 (§7.3D) — the team payroll grouped by role, the multi-agent
 * differentiator a single-agent tool can't show. ¥ per role is 大众-visible
 * (money is never gated, §7.1); rows arrive spend-desc from the server.
 */
function RolePayroll({
  lines,
  cnyPerUsd,
}: {
  lines: Summary["month_by_role"];
  cnyPerUsd: number;
}) {
  return (
    <div>
      <p className="text-sm text-foreground">本月各角色花销</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        多 Agent 团队按角色拆分的花销，竞品的单 Agent 做不到。
      </p>
      <div className="mt-3 rounded-xl border border-border bg-card">
        {lines.map((line, i) => (
          <div
            key={line.role}
            className={`flex items-center justify-between px-4 py-2.5 text-sm ${
              i > 0 ? "border-t border-border" : ""
            }`}
          >
            <span className="text-foreground">
              {roleLabel(line.role)}
              <span className="ml-2 text-xs text-muted-foreground">
                {line.turns} 回合
              </span>
            </span>
            <span className="tabular-nums text-foreground">
              {formatCost(line.cost_total, cnyPerUsd)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Power breakdown: today's tokens / cache hit rate, plus month cost + requests. */
function UsageDetail({
  summary,
  cnyPerUsd,
}: {
  summary: Summary;
  cnyPerUsd: number;
}) {
  const { today, month } = summary;
  const input = today.usage.input;
  const hitRate =
    input > 0 ? Math.round((today.usage.cache_hit / input) * 100) : 0;

  const rows: { label: string; value: string }[] = [
    {
      label: "今日 tokens",
      value: `输入 ${formatCompact(input)} · 输出 ${formatCompact(today.usage.output)}`,
    },
    { label: "今日缓存命中率", value: `${hitRate}%` },
    {
      label: "今日成本",
      value: `${formatCost(today.cost.total, cnyPerUsd)}（${formatUsd(today.cost.total)}）`,
    },
    {
      label: "本月成本",
      value: `${formatCost(month.cost.total, cnyPerUsd)}（${formatUsd(month.cost.total)}）`,
    },
    {
      label: "请求数",
      value: `今日 ${today.requests} · 本月 ${month.requests}`,
    },
  ];

  return (
    <div className="rounded-xl border border-border bg-card">
      {rows.map((row, i) => (
        <div
          key={row.label}
          className={`flex items-center justify-between px-4 py-2.5 text-sm ${
            i > 0 ? "border-t border-border" : ""
          }`}
        >
          <span className="text-muted-foreground">{row.label}</span>
          <span className="tabular-nums text-foreground">{row.value}</span>
        </div>
      ))}
    </div>
  );
}
