import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { CopyableId } from "@/components/CopyableId";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/services/api";
import {
  type BetaGroupModerator,
  appointBetaGroupModerator,
  listBetaGroupModerators,
  revokeBetaGroupModerator,
} from "@/services/adminBetaGroup";
import {
  type AdminUserListItem,
  listUsers,
} from "@/services/adminUsers";
import {
  RefreshCw,
  Shield,
  UserMinus,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

export function BetaGroupPage() {
  const [moderators, setModerators] = useState<BetaGroupModerator[]>([]);
  const [total, setTotal] = useState(0);
  const [chatId, setChatId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [appointUserId, setAppointUserId] = useState("");
  const [appointing, setAppointing] = useState(false);
  const [revoking, setRevoking] = useState<BetaGroupModerator | null>(null);

  // Lightweight user lookup (reuse admin users list; no new search surface).
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<AdminUserListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const searchAbortRef = useRef<AbortController | null>(null);

  const loadAbortRef = useRef<AbortController | null>(null);
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const ac = new AbortController();
    loadAbortRef.current = ac;
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await listBetaGroupModerators(ac.signal);
      if (ac.signal.aborted || gen !== loadGenRef.current) return;
      setModerators(res.data);
      setTotal(res.total);
      setChatId(res.chat_id);
      setTitle(res.title);
    } catch (err) {
      if (ac.signal.aborted || gen !== loadGenRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (!ac.signal.aborted && gen === loadGenRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadAbortRef.current?.abort();
      searchAbortRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const q = searchQ.trim();
    if (!q) {
      searchAbortRef.current?.abort();
      setSearchHits([]);
      setSearching(false);
      return;
    }
    const t = setTimeout(() => {
      searchAbortRef.current?.abort();
      const ac = new AbortController();
      searchAbortRef.current = ac;
      setSearching(true);
      void listUsers({ page: 1, pageSize: 8, q, status: "active" }, ac.signal)
        .then((res) => {
          if (ac.signal.aborted) return;
          setSearchHits(res.data);
        })
        .catch((err) => {
          if (ac.signal.aborted) return;
          toast.error(errorMessage(err));
          setSearchHits([]);
        })
        .finally(() => {
          if (!ac.signal.aborted) setSearching(false);
        });
    }, 300);
    return () => clearTimeout(t);
  }, [searchQ]);

  const handleAppoint = async (e?: FormEvent) => {
    e?.preventDefault();
    const userId = appointUserId.trim();
    if (!userId) {
      toast.error("请填写用户 ID");
      return;
    }
    if (appointing) return;
    setAppointing(true);
    try {
      const row = await appointBetaGroupModerator(userId);
      toast.success(`已任命 ${row.display_name || row.username} 为内测群版主`);
      setAppointUserId("");
      setSearchQ("");
      setSearchHits([]);
      void load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAppointing(false);
    }
  };

  const handleRevoke = async (mod: BetaGroupModerator) => {
    if (busyId) return;
    setBusyId(mod.id);
    try {
      await revokeBetaGroupModerator(mod.id);
      toast.success(`已撤销 ${mod.display_name || mod.username} 的版主身份`);
      setRevoking(null);
      setModerators((prev) => prev.filter((m) => m.id !== mod.id));
      setTotal((n) => Math.max(0, n - 1));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const pickUser = (u: AdminUserListItem) => {
    setAppointUserId(u.id);
    setSearchQ("");
    setSearchHits([]);
  };

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">内测群</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            任命 / 撤销「内测群版主」（群内{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              chat_members.role=admin
            </code>
            ）· 不是升平台管理员 · 平台 admin 已自带群治理权 · 共 {total} 人
          </p>
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

      {(title || chatId) && (
        <div className="mb-5 rounded-xl border border-border bg-card px-5 py-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <UsersRound size={16} className="text-muted-foreground" />
              <span className="font-medium text-foreground">
                {title ?? "内测群"}
              </span>
            </div>
            {chatId && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="text-xs">群 ID</span>
                <CopyableId value={chatId} label="chat_id" />
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            版主仅获得该群的治理能力；不会获得管理后台或平台级权限。
          </p>
        </div>
      )}

      <div className="mb-5 rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 text-sm font-semibold text-foreground">任命版主</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          输入用户 ID，或按用户名 / 显示名搜索后选中。任命会确保其已加入内测群。
        </p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => void handleAppoint(e)}
        >
          <label className="flex min-w-[240px] flex-1 flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">用户 ID</span>
            <Input
              value={appointUserId}
              onChange={(e) => setAppointUserId(e.target.value)}
              placeholder="粘贴 user_id"
              aria-label="用户 ID"
              disabled={appointing}
            />
          </label>
          <Button type="submit" size="sm" disabled={appointing}>
            {appointing ? <Spinner /> : <UserPlus size={14} />}
            任命
          </Button>
        </form>

        <div className="mt-4">
          <label className="flex max-w-md flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
              搜索用户（可选）
            </span>
            <Input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="用户名 / 显示名"
              aria-label="搜索用户"
              disabled={appointing}
            />
          </label>
          {(searching || searchHits.length > 0) && (
            <div className="mt-2 max-w-md overflow-hidden rounded-lg border border-border bg-muted/30">
              {searching && searchHits.length === 0 && (
                <div className="flex items-center gap-2 px-3 py-2.5 text-muted-foreground text-xs">
                  <Spinner />
                  搜索中…
                </div>
              )}
              {searchHits.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => pickUser(u)}
                  className="flex w-full items-center justify-between gap-3 border-border border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-accent"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-foreground">
                      {u.display_name || u.username}
                    </span>
                    <span className="ml-2 text-muted-foreground">
                      @{u.username}
                    </span>
                  </span>
                  {u.role === "admin" && (
                    <Badge tone="primary">平台 admin</Badge>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-5 py-2.5 font-medium">用户</th>
              <th className="px-5 py-2.5 font-medium">用户 ID</th>
              <th className="px-5 py-2.5 font-medium">备注</th>
              <th className="px-5 py-2.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {moderators.map((m) => {
              const rowBusy = busyId === m.id;
              return (
                <tr
                  key={m.id}
                  className="border-border border-b last:border-0 hover:bg-accent/40"
                >
                  <td className="px-5 py-3">
                    <div className="font-medium text-foreground">
                      {m.display_name || m.username}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      @{m.username}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <CopyableId value={m.id} label="user_id" />
                  </td>
                  <td className="px-5 py-3">
                    {m.is_platform_admin ? (
                      <Badge tone="primary">
                        <Shield size={12} className="mr-1" />
                        平台 admin（自带群治理）
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">群版主</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={rowBusy || !!busyId}
                      onClick={() => setRevoking(m)}
                    >
                      {rowBusy ? <Spinner /> : <UserMinus size={14} />}
                      撤销
                    </Button>
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
        {!loading && !error && moderators.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground text-sm">
            <UsersRound size={24} className="text-muted-foreground/60" />
            暂无内测群版主，在上方任命第一位
          </div>
        )}
      </div>

      {revoking && (
        <RevokeDialog
          moderator={revoking}
          busy={busyId === revoking.id}
          onClose={() => setRevoking(null)}
          onConfirm={() => void handleRevoke(revoking)}
        />
      )}
    </div>
  );
}

function RevokeDialog({
  moderator,
  busy,
  onClose,
  onConfirm,
}: {
  moderator: BetaGroupModerator;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
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
              撤销内测群版主
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              角色将降为普通群成员，仍留在群内
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

        <p className="text-sm text-muted-foreground">
          确认撤销{" "}
          <span className="font-medium text-foreground">
            {moderator.display_name || moderator.username}
          </span>
          （@{moderator.username}）的内测群版主身份？这不会影响其平台账号角色。
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Spinner /> : <UserMinus size={14} />}
            确认撤销
          </Button>
        </div>
      </div>
    </div>
  );
}
