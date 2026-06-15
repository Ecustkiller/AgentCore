import { SimpleTooltip } from "@/components/ui/tooltip";
import { type Invite, createInvite, listInvites } from "@/services/invites";
import { useAuthStore } from "@/stores/auth";
import { Check, Copy, Plus } from "lucide-react";
import { useEffect, useState } from "react";

const STATUS_LABEL: Record<Invite["status"], string> = {
  active: "可用",
  used: "已使用",
  expired: "已过期",
};

const STATUS_CLASS: Record<Invite["status"], string> = {
  active: "bg-success/10 text-success",
  used: "bg-muted text-muted-foreground",
  expired: "bg-destructive/10 text-destructive",
};

export function MembersSettings() {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await listInvites();
        if (!cancelled) setInvites(data);
      } catch {
        if (!cancelled) setError("加载邀请码失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const invite = await createInvite();
      setInvites((prev) => [invite, ...prev]);
    } catch {
      setError("生成邀请码失败");
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied((c) => (c === code ? null : c)), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  if (!isAdmin) {
    return (
      <div>
        <h1 className="text-xl font-semibold">成员</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          仅管理员可生成和管理邀请码。
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">成员</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            生成邀请码邀请新成员注册。每个邀请码仅可使用一次。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating}
          className="flex h-8 shrink-0 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <Plus size={16} />
          {creating ? "生成中…" : "生成邀请码"}
        </button>
      </div>

      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

      <div className="mt-6 space-y-2">
        {loading ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : invites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有邀请码，点击右上角生成第一个。
          </p>
        ) : (
          invites.map((invite) => (
            <div
              key={invite.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
            >
              <code className="flex-1 truncate font-mono text-sm text-foreground">
                {invite.code}
              </code>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[invite.status]}`}
              >
                {STATUS_LABEL[invite.status]}
              </span>
              <SimpleTooltip label="复制邀请码">
                <button
                  type="button"
                  onClick={() => void handleCopy(invite.code)}
                  disabled={invite.status !== "active"}
                  aria-label="复制邀请码"
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                >
                  {copied === invite.code ? (
                    <Check size={14} />
                  ) : (
                    <Copy size={14} />
                  )}
                </button>
              </SimpleTooltip>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
