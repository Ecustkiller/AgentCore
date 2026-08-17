import { Card, SectionHeader } from "@/components/ui/Page";
import { ErrorState } from "@/components/ui/States";
import {
  cn,
  fmtInt,
  fmtMoney,
  fmtTimeUtc,
  nanoToMajor,
} from "@/lib/utils";
import type { AdminGoWindow, AdminGoWindows } from "@/services/adminUsage";
import { Info } from "lucide-react";

const GO_CAPS_USD = {
  five_hour: 12,
  weekly: 30,
  monthly: 60,
} as const;

/**
 * OpenCode Go 5h / week / month — nominal CNY plus a public-list USD estimate.
 * Neither number is an upstream bill or balance.
 */
export function GoWindowsCard({
  data,
  error,
  onRetry,
}: {
  data: AdminGoWindows | null;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Card>
      <SectionHeader
        title="OpenCode Go 窗口"
        description="平台代付 · 固定窗语义（5 小时不是近 5 小时滑动求和）"
      />
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <Info size={16} className="mt-0.5 shrink-0 text-primary" />
          <span>
            {data
              ? honestyCopy(data.estimate_model, data.estimate_price_as_of)
              : honestyCopy("deepseek-v4-flash", "2026-08-18")}
          </span>
        </div>

        {error && !data ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : data && !hasGoTraffic(data) ? (
          <div className="rounded-xl border border-border px-4 py-6">
            <div className="text-lg font-semibold text-foreground">尚无 Go 流量</div>
            <p className="mt-1 text-sm text-muted-foreground">
              还没有经由 OpenCode Go 端点（/zen/go/v1）的调用。Zen 与免费模型不计入 $12 /
              $30 / $60 窗口。
            </p>
          </div>
        ) : data ? (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <WindowCell
                label="5 小时窗"
                window={data.five_hour}
                capUsd={GO_CAPS_USD.five_hour}
                asOf={data.as_of}
                emptyHint="尚无进行中的 5 小时窗（空闲超窗已归零）"
              />
              <WindowCell
                label="本周（UTC 周一）"
                window={data.weekly}
                capUsd={GO_CAPS_USD.weekly}
                asOf={data.as_of}
              />
              <WindowCell
                label={`本月（订阅日 ${data.subscription_day}）`}
                window={data.monthly}
                capUsd={GO_CAPS_USD.monthly}
                asOf={data.as_of}
              />
            </div>
            {(data.members ?? []).map((member) => (
              <div key={member.platform_credential_id} className="flex flex-col gap-3">
                <div className="text-sm font-medium text-foreground">
                  {member.label}
                  <span className="ml-2 font-normal text-muted-foreground">
                    订阅日 {member.subscription_day}
                    {member.enabled ? "" : " · 已禁用"}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <WindowCell
                    label="5 小时窗"
                    window={member.five_hour}
                    capUsd={GO_CAPS_USD.five_hour}
                    asOf={data.as_of}
                    emptyHint="尚无进行中的 5 小时窗"
                  />
                  <WindowCell
                    label="本周（UTC 周一）"
                    window={member.weekly}
                    capUsd={GO_CAPS_USD.weekly}
                    asOf={data.as_of}
                  />
                  <WindowCell
                    label={`本月（订阅日 ${member.subscription_day}）`}
                    window={member.monthly}
                    capUsd={GO_CAPS_USD.monthly}
                    asOf={data.as_of}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function hasGoTraffic(data: AdminGoWindows): boolean {
  if (data.five_hour.calls || data.weekly.calls || data.monthly.calls) return true;
  return (data.members ?? []).some(
    (member) => member.five_hour.calls || member.weekly.calls || member.monthly.calls,
  );
}

function honestyCopy(model: string, priceAsOf: string): string {
  return (
    `名义价是我方 curated 扣额度用的 CNY，不是上游美元用量。` +
    `美元是按 OpenCode 公开单价（${model}，截至 ${priceAsOf}）对每次调用按时段（Peak / Off-Peak）估算的，` +
    `用来看离 $12 / $30 / $60 还有多远——不是上游账单或余额。` +
    `未证死：① Go 计入窗口前可能乘未公开的 costMultiplier（默认 1），实际若大于 1 则估算偏低；` +
    `② 上游网关是否识别 DeepSeek 的 cache 命中字段未经实包验证，若不识别则我们按 Cached Read 计价会低估。`
  );
}

function WindowCell({
  label,
  window,
  capUsd,
  asOf,
  emptyHint,
}: {
  label: string;
  window: AdminGoWindow;
  capUsd: number;
  asOf: string;
  emptyHint?: string;
}) {
  const resetPast =
    window.reset_at != null && Date.parse(window.reset_at) <= Date.parse(asOf);
  const estimateMajor = nanoToMajor(window.estimated_usd_nano);
  const remaining = capUsd - estimateMajor;

  return (
    <div className="rounded-xl border border-border px-4 py-3">
      <div className="text-muted-foreground text-sm">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground tabular-nums">
        {fmtMoney(nanoToMajor(window.cost_total_nano), "CNY")}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">名义价 · 非上游用量</div>
      <div className="mt-3 text-lg font-semibold text-foreground tabular-nums">
        ≈{fmtMoney(estimateMajor, "USD")}
        <span className="text-sm font-normal text-muted-foreground">
          {" "}
          / {fmtMoney(capUsd, "USD")}
        </span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        公开单价估算 · 非上游账单
        {remaining >= 0
          ? ` · 约剩 ${fmtMoney(remaining, "USD")}`
          : ` · 已超估算帽 ${fmtMoney(-remaining, "USD")}`}
      </div>
      <div className="mt-3 flex flex-col gap-1 text-sm text-muted-foreground">
        <span>调用 {fmtInt(window.calls)}</span>
        {window.started_at && (
          <span>
            起于 <span className="tabular-nums">{fmtTimeUtc(window.started_at)}</span> UTC
          </span>
        )}
        {window.reset_at ? (
          <span className={cn(resetPast && "text-foreground")}>
            {resetPast ? "已于 " : "重置 "}
            <span className="tabular-nums">{fmtTimeUtc(window.reset_at)}</span> UTC
            {resetPast ? " 归零" : ""}
          </span>
        ) : (
          emptyHint && <span>{emptyHint}</span>
        )}
      </div>
    </div>
  );
}
