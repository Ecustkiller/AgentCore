import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { cn, fmtTime } from "@/lib/utils";
import { errorMessage } from "@/services/api";
import {
  type Invite,
  type InviteStatus,
  createInvitesBatch,
  listInvites,
  revokeInvite,
} from "@/services/adminInvites";
import { Ban, Copy, ChevronLeft, ChevronRight, Plus, RefreshCw, Ticket, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type Tone = "success" | "neutral" | "warning" | "destructive";

// active = 可发放（绿）; used = 已消耗的终态（中性）; expired = 失效未用（琥珀，提示可清理/重发）;
// revoked = 管理员主动作废（红，终态，不可再注册）。
const STATUS: Record<InviteStatus, { label: string; tone: Tone }> = {
  active: { label: "可用", tone: "success" },
  used: { label: "已使用", tone: "neutral" },
  expired: { label: "已过期", tone: "warning" },
  revoked: { label: "已撤销", tone: "destructive" },
};

const PAGE_SIZE = 20;

type StatusFilter = InviteStatus | "all";

/** Newest-first by creation time, regardless of server order (stable after prepend). */
function byCreatedDesc(a: Invite, b: Invite): number {
  return b.created_at.localeCompare(a.created_at);
}

async function copyCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    toast.success("邀请码已复制");
  } catch {
    toast.error("复制失败，请手动选择复制");
  }
}

export function InvitesPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Codes from a multi-invite batch, shown in a follow-up dialog (null = hidden).
  const [batchCodes, setBatchCodes] = useState<string[] | null>(null);
  // The invite the operator is about to burn (null = no dialog open).
  const [revoking, setRevoking] = useState<Invite | null>(null);

  const fetchPage = useCallback(
    async (targetPage: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await listInvites({
          page: targetPage,
          pageSize: PAGE_SIZE,
          status: statusFilter === "all" ? undefined : statusFilter,
        });
        setInvites([...res.data].sort(byCreatedDesc));
        setTotal(res.total);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [statusFilter],
  );

  const load = useCallback(() => fetchPage(page), [fetchPage, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreated = (created: Invite[]) => {
    setCreating(false);
    if (created.length === 1) {
      void copyCode(created[0].code);
      toast.success("邀请码已生成并复制到剪贴板");
    } else {
      setBatchCodes(created.map((i) => i.code));
      toast.success(`已生成 ${created.length} 个邀请码`);
    }
    setPage(1);
    void fetchPage(1);
  };

  // Swap the now-revoked record into place (keeps sort + counts honest) and dismiss.
  const onRevoked = (updated: Invite) => {
    setInvites((prev) =>
      prev.map((i) => (i.id === updated.id ? updated : i)).sort(byCreatedDesc),
    );
    setRevoking(null);
  };

  const activeOnPage = invites.filter((i) => i.status === "active").length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">邀请码</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            新用户注册需邀请码 · 共 {total} 个
            {statusFilter === "all" ? "" : `（筛选：${STATUS[statusFilter].label}）`}
            {statusFilter === "all" || statusFilter === "active"
              ? ` · 本页 ${activeOnPage} 个可用`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} />
            生成邀请码
          </Button>
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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as StatusFilter);
            setPage(1);
          }}
          aria-label="按状态筛选"
          className="h-9 rounded-lg border border-input bg-card px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">全部状态</option>
          <option value="active">可用</option>
          <option value="used">已使用</option>
          <option value="expired">已过期</option>
          <option value="revoked">已撤销</option>
        </select>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-5 py-2.5 font-medium">邀请码</th>
              <th className="px-5 py-2.5 font-medium">状态</th>
              <th className="px-5 py-2.5 font-medium">有效期</th>
              <th className="px-5 py-2.5 font-medium">使用情况</th>
              <th className="px-5 py-2.5 font-medium">创建时间</th>
              <th className="px-5 py-2.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {invites.map((inv) => {
              const s = STATUS[inv.status];
              return (
                <tr
                  key={inv.id}
                  className="border-border border-b last:border-0 hover:bg-accent/40"
                >
                  <td className="px-5 py-3">
                    <button
                      type="button"
                      onClick={() => void copyCode(inv.code)}
                      title="点击复制"
                      className="group inline-flex items-center gap-2 rounded-lg font-mono text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {inv.code}
                      <Copy
                        size={14}
                        className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      />
                    </button>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground tabular-nums">
                    {inv.expires_at ? fmtTime(inv.expires_at) : "永久"}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground tabular-nums">
                    {inv.used_at ? (
                      <span title={inv.used_by ?? undefined}>
                        {fmtTime(inv.used_at)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground tabular-nums">
                    {fmtTime(inv.created_at)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {inv.status === "active" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setRevoking(inv)}
                      >
                        <Ban size={14} />
                        撤销
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
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
        {!loading && !error && invites.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground text-sm">
            <Ticket size={24} className="text-muted-foreground/60" />
            {statusFilter === "all"
              ? "还没有邀请码，点击「生成邀请码」创建第一个"
              : `没有「${STATUS[statusFilter].label}」状态的邀请码`}
          </div>
        )}
      </div>

      {total > PAGE_SIZE && (
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
      )}

      {creating && (
        <CreateInviteDialog
          onClose={() => setCreating(false)}
          onCreated={onCreated}
        />
      )}

      {revoking && (
        <RevokeInviteDialog
          invite={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={onRevoked}
        />
      )}

      {batchCodes && (
        <BatchCodesDialog codes={batchCodes} onClose={() => setBatchCodes(null)} />
      )}
    </div>
  );
}

function RevokeInviteDialog({
  invite,
  onClose,
  onRevoked,
}: {
  invite: Invite;
  onClose: () => void;
  onRevoked: (updated: Invite) => void;
}) {
  const [saving, setSaving] = useState(false);

  const handleRevoke = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await revokeInvite(invite.id);
      toast.success("邀请码已撤销");
      onRevoked(updated);
    } catch (err) {
      toast.error(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-6"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              撤销邀请码
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              撤销后该码立即作废，无法再用于注册，且不可恢复
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-center font-mono text-foreground">
          {invite.code}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void handleRevoke()}
            disabled={saving}
          >
            {saving && <Spinner />}
            确认撤销
          </Button>
        </div>
      </div>
    </div>
  );
}

function CreateInviteDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (invites: Invite[]) => void;
}) {
  const [count, setCount] = useState("1");
  const [days, setDays] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const qty = Math.max(1, Math.min(100, Number(count.trim()) || 1));
    setSaving(true);
    const trimmed = days.trim();
    try {
      const res = await createInvitesBatch(
        qty,
        trimmed ? Number(trimmed) : undefined,
      );
      onCreated(res.data);
    } catch (err) {
      toast.error(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-6"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              生成邀请码
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              单个生成后自动复制；批量生成可在结果中一键复制全部
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              数量
            </span>
            <Input
              type="number"
              min={1}
              max={100}
              inputMode="numeric"
              placeholder="1"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              有效天数
            </span>
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              placeholder="留空 = 永久有效"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </label>

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving && <Spinner />}
              生成
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function BatchCodesDialog({
  codes,
  onClose,
}: {
  codes: string[];
  onClose: () => void;
}) {
  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast.success(`已复制 ${codes.length} 个邀请码`);
    } catch {
      toast.error("复制失败，请手动选择复制");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-6"
      onMouseDown={onClose}
    >
      <div
        className="flex w-full max-w-md flex-col rounded-xl border border-border bg-card p-5 shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              已生成 {codes.length} 个邀请码
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              点击单行可复制；或一键复制全部（换行分隔）
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-muted/40">
          {codes.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => void copyCode(code)}
              className="flex w-full items-center justify-between gap-2 border-border border-b px-4 py-2 font-mono text-sm text-foreground last:border-0 hover:bg-accent/40"
            >
              {code}
              <Copy size={14} className="shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleCopyAll()}>
            <Copy size={14} />
            复制全部
          </Button>
          <Button size="sm" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    </div>
  );
}
