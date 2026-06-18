import { QuotaDialog } from "@/components/QuotaDialog";
import { UserDetail } from "@/components/UserDetail";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/services/api";
import {
  type AdminUser,
  listUsers,
  updateUser,
} from "@/services/adminUsers";
import { useAuthStore } from "@/stores/auth";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const PAGE_SIZE = 20;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function quotaSummary(u: AdminUser): string {
  if (u.is_unlimited) return "无限额";
  const tokens = u.quota_daily_tokens ?? "继承";
  const cost = u.quota_monthly_cost_usd ?? "继承";
  const req = u.quota_daily_requests ?? "继承";
  return `日 ${tokens} token · 月 $${cost} · ${req} 请求`;
}

export function UsersPage() {
  const selfId = useAuthStore((s) => s.user?.id);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<AdminUser | null>(null);
  // Drill-in: a user id opens the 用户详情 view (replacing the roster).
  const [detailId, setDetailId] = useState<string | null>(null);

  // Debounce the search box; a new query always restarts at page 1.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listUsers({ page, pageSize: PAGE_SIZE, q: debouncedQ });
      setUsers(res.data);
      setTotal(res.total);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, debouncedQ]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchRow = useCallback(
    async (
      user: AdminUser,
      patch: Parameters<typeof updateUser>[1],
      okMsg: string,
    ) => {
      setPending((prev) => new Set(prev).add(user.id));
      try {
        const updated = await updateUser(user.id, patch);
        setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
        toast.success(okMsg);
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(user.id);
          return next;
        });
      }
    },
    [],
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (detailId) {
    return <UserDetail userId={detailId} onBack={() => setDetailId(null)} />;
  }

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">用户管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {total} 个账号 · 禁用 / 启用、改角色、改配额
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              size={14}
              className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 text-muted-foreground"
            />
            <Input
              type="search"
              placeholder="搜索用户名 / 昵称"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-64 pl-8"
            />
          </div>
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
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">用户</th>
              <th className="px-4 py-2.5 font-medium">角色</th>
              <th className="px-4 py-2.5 font-medium">状态</th>
              <th className="px-4 py-2.5 font-medium">配额</th>
              <th className="px-4 py-2.5 font-medium">注册时间</th>
              <th className="px-4 py-2.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === selfId;
              const busy = pending.has(u.id);
              return (
                <tr
                  key={u.id}
                  className="border-border border-b last:border-0 hover:bg-accent/40"
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setDetailId(u.id)}
                      title="查看用户详情"
                      className="rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="font-medium text-foreground hover:underline">
                        {u.display_name || u.username}
                        {isSelf && (
                          <span className="ml-2 text-muted-foreground text-xs">
                            (我)
                          </span>
                        )}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        @{u.username}
                        {u.email ? ` · ${u.email}` : ""}
                      </div>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={u.role}
                      disabled={isSelf || busy}
                      onChange={(e) =>
                        void patchRow(
                          u,
                          { role: e.target.value as "user" | "admin" },
                          "角色已更新",
                        )
                      }
                      title={isSelf ? "不能修改自己的角色" : undefined}
                      className="h-8 rounded-lg border border-input bg-card px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    {u.status === "active" ? (
                      <Badge tone="success">活跃</Badge>
                    ) : (
                      <Badge tone="destructive">已停用</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {quotaSummary(u)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {fmtDate(u.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(u)}
                        disabled={busy}
                      >
                        配额
                      </Button>
                      {u.status === "active" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isSelf || busy}
                          title={isSelf ? "不能停用自己" : undefined}
                          className="text-destructive"
                          onClick={() =>
                            void patchRow(
                              u,
                              { status: "disabled" },
                              "账号已停用",
                            )
                          }
                        >
                          {busy ? <Spinner /> : "停用"}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void patchRow(u, { status: "active" }, "账号已启用")
                          }
                        >
                          {busy ? <Spinner /> : "启用"}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground text-sm">
            <Spinner />
            加载中…
          </div>
        )}
        {!loading && error && (
          <div className="flex flex-col items-center gap-3 py-10 text-sm">
            <span className="text-destructive">{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        )}
        {!loading && !error && users.length === 0 && (
          <div className="py-10 text-center text-muted-foreground text-sm">
            没有匹配的用户
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between text-muted-foreground text-sm">
        <span>
          第 {page} / {totalPages} 页
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft size={14} />
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>

      {editing && (
        <QuotaDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setUsers((prev) =>
              prev.map((u) => (u.id === updated.id ? updated : u)),
            );
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
