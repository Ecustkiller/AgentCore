import { CostTrendBars } from "@/components/charts";
import { ResetPasswordDialog } from "@/components/ResetPasswordDialog";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import {
  cn,
  fmtCny,
  fmtCompact,
  fmtInt,
  fmtMs,
  fmtTime,
  nanoUsdToCny,
} from "@/lib/utils";
import { errorMessage } from "@/services/api";
import type { UsageWindow } from "@/services/adminUsage";
import type { TurnMetricLine } from "@/services/adminObservability";
import {
  type AdminConversationLine,
  type AdminUserDetail,
  type RoleCostLine,
  fetchUserDetail,
} from "@/services/adminUsers";
import { ArrowLeft, ExternalLink, KeyRound, MessageSquare, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

function quotaSummary(u: AdminUserDetail["user"]): string {
  if (u.is_unlimited) return "无限额";
  const tokens = u.quota_daily_tokens ?? "继承";
  const cost = u.quota_monthly_cost_usd ?? "继承";
  const req = u.quota_daily_requests ?? "继承";
  return `日 ${tokens} token · 月 $${cost} · ${req} 请求`;
}

export function UserDetail({
  userId,
  onBack,
}: {
  userId: string;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const openReplay = (conversationId: string) => {
    navigate(`/replay/${conversationId}`, { state: { from: location.pathname } });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchUserDetail(userId));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const user = data?.user;
  const byok = data?.billing_mode === "byok";

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-8">
      <div className="mb-4 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
        >
          <ArrowLeft size={16} />
          返回用户列表
        </button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          aria-label="刷新"
        >
          <RefreshCw size={14} className={cn(loading && "animate-spin")} />
        </Button>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card py-16 text-muted-foreground text-sm">
          <Spinner />
          加载中…
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card py-16 text-sm">
          <span className="text-destructive">{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}

      {!loading && !error && data && user && (
        <div className="flex flex-col gap-5">
          <header className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-xl font-semibold text-foreground">
                  {user.display_name || user.username}
                </h1>
                <Badge tone={user.role === "admin" ? "primary" : "neutral"}>
                  {user.role}
                </Badge>
                <Badge
                  tone={user.status === "active" ? "success" : "destructive"}
                >
                  {user.status === "active" ? "活跃" : "已停用"}
                </Badge>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setResetting(true)}
              >
                <KeyRound size={14} />
                重置密码
              </Button>
            </div>
            <p className="mt-1 text-muted-foreground text-sm">
              @{user.username}
              {user.email ? ` · ${user.email}` : ""}
              {" · 注册 "}
              {fmtTime(user.created_at)}
            </p>
            <p className="mt-3 text-muted-foreground text-xs">
              配额：{quotaSummary(user)}
            </p>
          </header>

          {byok && (
            <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-muted-foreground text-xs">
              BYOK 模式：以下成本为该用户在自己 DeepSeek Key 上的花费，并非平台垫付。
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <WindowCard label="今日" window={data.today} />
            <WindowCard label="本月" window={data.month} />
          </div>

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-4 text-base font-semibold text-foreground">
              近 7 日成本趋势
            </h2>
            <CostTrendBars
              data={data.recent_daily_cost}
              cnyPerUsd={data.cny_per_usd}
            />
          </section>

          {data.month_by_role.length > 0 && (
            <section className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="border-border border-b px-5 py-3.5">
                <h2 className="text-base font-semibold text-foreground">
                  本月各角色花销
                </h2>
                <p className="mt-0.5 text-muted-foreground text-xs">
                  多 Agent 团队工资单（按成本降序）
                </p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-border border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2.5 font-medium">角色</th>
                    <th className="px-5 py-2.5 text-right font-medium">成本</th>
                    <th className="px-5 py-2.5 text-right font-medium">回合数</th>
                  </tr>
                </thead>
                <tbody>
                  {data.month_by_role.map((row: RoleCostLine) => (
                    <tr
                      key={row.role}
                      className="border-border border-b last:border-0"
                    >
                      <td className="px-5 py-3 text-foreground">{row.role}</td>
                      <td className="px-5 py-3 text-right font-medium text-foreground tabular-nums">
                        {fmtCny(nanoUsdToCny(row.cost_total, data.cny_per_usd))}
                      </td>
                      <td className="px-5 py-3 text-right text-muted-foreground tabular-nums">
                        {fmtInt(row.turns)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <ConversationsTable
            rows={data.conversations}
            userId={user.id}
            onOpen={openReplay}
          />

          <RecentTurnsTable
            rows={data.recent_turns}
            userId={user.id}
            onOpen={openReplay}
          />

          {resetting && (
            <ResetPasswordDialog
              userId={user.id}
              username={user.username}
              onClose={() => setResetting(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function WindowCard({ label, window }: { label: string; window: UsageWindow }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-muted-foreground text-sm">{label}总成本</div>
      <div className="mt-1 text-2xl font-semibold text-foreground tabular-nums">
        {fmtCny(window.cost.cny_total)}
      </div>
      <div className="mt-4 flex items-center gap-6 text-sm">
        <Stat
          label="Token"
          value={fmtCompact(window.usage.input + window.usage.output)}
        />
        <Stat label="请求" value={fmtInt(window.requests)} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-0.5 font-medium text-foreground tabular-nums">
        {value}
      </div>
    </div>
  );
}

function ConversationsTable({
  rows,
  userId,
  onOpen,
}: {
  rows: AdminConversationLine[];
  userId: string;
  onOpen: (conversationId: string) => void;
}) {
  const navigate = useNavigate();
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-border border-b px-5 py-3.5">
        <div>
          <h2 className="text-base font-semibold text-foreground">最近会话</h2>
          <p className="mt-0.5 text-muted-foreground text-xs">
            按最近活动排序 · 点击行进入会话复盘
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() =>
            navigate(`/conversations/conversations?user_id=${encodeURIComponent(userId)}`)
          }
        >
          <ExternalLink size={14} />
          查看全部
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-border border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="px-5 py-2.5 font-medium">标题</th>
            <th className="px-5 py-2.5 text-right font-medium">消息数</th>
            <th className="px-5 py-2.5 font-medium">更新时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr
              key={c.id}
              onClick={() => onOpen(c.id)}
              className="cursor-pointer border-border border-b last:border-0 hover:bg-accent/40"
            >
              <td className="px-5 py-3 text-foreground">
                {c.title || (
                  <span className="text-muted-foreground italic">未命名会话</span>
                )}
              </td>
              <td className="px-5 py-3 text-right text-muted-foreground tabular-nums">
                {fmtInt(c.messages)}
              </td>
              <td className="px-5 py-3 text-muted-foreground tabular-nums">
                {fmtTime(c.updated_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground text-sm">
          <MessageSquare size={22} className="text-muted-foreground/60" />
          该用户暂无会话
        </div>
      )}
    </section>
  );
}

function RecentTurnsTable({
  rows,
  userId,
  onOpen,
}: {
  rows: TurnMetricLine[];
  userId: string;
  onOpen: (conversationId: string) => void;
}) {
  const navigate = useNavigate();
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-border border-b px-5 py-3.5">
        <div>
          <h2 className="text-base font-semibold text-foreground">最近活动</h2>
          <p className="mt-0.5 text-muted-foreground text-xs">
            最近的回合（newest-first）· 点击行进入会话复盘
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() =>
            navigate(
              `/conversations/turns?user_id=${encodeURIComponent(userId)}`,
            )
          }
        >
          <ExternalLink size={14} />
          查看全部
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-border border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="px-5 py-2.5 font-medium">时间</th>
            <th className="px-5 py-2.5 font-medium">状态</th>
            <th className="px-5 py-2.5 font-medium">结束原因</th>
            <th className="px-5 py-2.5 text-right font-medium">轮数</th>
            <th className="px-5 py-2.5 text-right font-medium">耗时</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const isError = t.status === "error";
            return (
              <tr
                key={t.turn_id}
                onClick={() => onOpen(t.conversation_id)}
                className="cursor-pointer border-border border-b align-top last:border-0 hover:bg-accent/40"
              >
                <td className="whitespace-nowrap px-5 py-3 text-muted-foreground tabular-nums">
                  {fmtTime(t.created_at)}
                </td>
                <td className="px-5 py-3">
                  <Badge tone={isError ? "destructive" : "success"}>
                    {isError ? "失败" : "成功"}
                  </Badge>
                </td>
                <td className="max-w-xs px-5 py-3 text-muted-foreground">
                  <span className="line-clamp-2 break-words">
                    {isError ? (t.error ?? t.finish_reason ?? "error") : (t.finish_reason ?? "—")}
                  </span>
                </td>
                <td className="px-5 py-3 text-right text-muted-foreground tabular-nums">
                  {fmtInt(t.rounds)}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right text-muted-foreground tabular-nums">
                  {fmtMs(t.duration_ms)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="py-10 text-center text-muted-foreground text-sm">
          该用户暂无回合活动
        </div>
      )}
    </section>
  );
}
