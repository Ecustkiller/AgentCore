import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { cn, fmtTime } from "@/lib/utils";
import { errorMessage } from "@/services/api";
import {
  type Invite,
  type InviteStatus,
  createInvite,
  listInvites,
  revokeInvite,
} from "@/services/adminInvites";
import { Ban, Copy, Plus, RefreshCw, Ticket, X } from "lucide-react";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The invite the operator is about to burn (null = no dialog open).
  const [revoking, setRevoking] = useState<Invite | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listInvites();
      setInvites([...res.data].sort(byCreatedDesc));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreated = (invite: Invite) => {
    setInvites((prev) => [invite, ...prev].sort(byCreatedDesc));
    setCreating(false);
    void copyCode(invite.code);
  };

  // Swap the now-revoked record into place (keeps sort + counts honest) and dismiss.
  const onRevoked = (updated: Invite) => {
    setInvites((prev) =>
      prev.map((i) => (i.id === updated.id ? updated : i)).sort(byCreatedDesc),
    );
    setRevoking(null);
  };

  const activeCount = invites.filter((i) => i.status === "active").length;

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">邀请码</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            新用户注册需邀请码 · 共 {invites.length} 个，{activeCount} 个可用
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
            还没有邀请码，点击「生成邀请码」创建第一个
          </div>
        )}
      </div>

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
  onCreated: (invite: Invite) => void;
}) {
  const [days, setDays] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    const trimmed = days.trim();
    try {
      const invite = await createInvite(trimmed ? Number(trimmed) : undefined);
      toast.success("邀请码已生成并复制到剪贴板");
      onCreated(invite);
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
              生成后自动复制到剪贴板，发给受邀用户用于注册
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
              有效天数
            </span>
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              placeholder="留空 = 永久有效"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              autoFocus
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
