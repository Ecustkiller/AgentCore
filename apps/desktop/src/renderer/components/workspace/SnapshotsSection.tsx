import { SimpleTooltip } from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/format";
import {
  type WorkspaceSnapshot,
  createSnapshot,
  downloadSnapshot,
  listSnapshots,
  restoreSnapshot,
} from "@/services/workspace";
import {
  Camera,
  Download,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Centered,
  EmptyHint,
  IconButton,
  InlineError,
} from "@/components/files/parts";

export function SnapshotsSection({
  conversationId,
}: {
  conversationId: string;
}) {
  const [snaps, setSnaps] = useState<WorkspaceSnapshot[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setSnaps(await listSnapshots(conversationId));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await createSnapshot(conversationId, label);
      setLabel("");
      await reload();
    } catch {
      setError(true);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onCreate();
          }}
          placeholder="版本名（可选）"
          maxLength={200}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
        />
        <SimpleTooltip label="为当前工作区留一个快照版本">
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={creating}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {creating ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Camera size={13} />
            )}
            留版本
          </button>
        </SimpleTooltip>
        <IconButton
          title="刷新"
          onClick={() => void reload()}
          spinning={loading}
        >
          <RefreshCw size={14} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error ? (
          <InlineError onRetry={() => void reload()} />
        ) : snaps === null ? (
          <Centered>
            <Loader2
              size={18}
              className="animate-spin text-muted-foreground/50"
            />
          </Centered>
        ) : snaps.length === 0 ? (
          <EmptyHint
            inline
            icon={<History size={22} className="text-muted-foreground/40" />}
            title="暂无快照"
            hint="改动文件的回合结束后会自动备份；也可随时手动留一个版本。"
          />
        ) : (
          <ul className="space-y-1">
            {snaps.map((s) => (
              <SnapshotRow
                key={s.snapshotId}
                conversationId={conversationId}
                snap={s}
                onRestored={() => void reload()}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SnapshotRow({
  conversationId,
  snap,
  onRestored,
}: {
  conversationId: string;
  snap: WorkspaceSnapshot;
  onRestored: () => void;
}) {
  const [busy, setBusy] = useState<"download" | "restore" | null>(null);

  const onDownload = async () => {
    if (busy) return;
    setBusy("download");
    try {
      await downloadSnapshot(conversationId, snap.snapshotId);
    } catch {
      /* surfaced by the button's transient state only */
    } finally {
      setBusy(null);
    }
  };

  const onRestore = async () => {
    if (busy) return;
    if (!window.confirm("恢复到该快照会覆盖当前工作区的所有文件，确定继续？")) {
      return;
    }
    setBusy("restore");
    try {
      await restoreSnapshot(conversationId, snap.snapshotId);
      onRestored();
    } catch {
      /* best-effort; the list reload reflects the real state */
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="rounded-md border border-border px-2.5 py-2">
      <div className="flex items-center gap-2">
        {snap.label ? (
          <SimpleTooltip label={snap.label}>
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {snap.label}
            </span>
          </SimpleTooltip>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            自动备份
          </span>
        )}
        <IconButton
          title="下载快照 (zip)"
          onClick={() => void onDownload()}
          spinning={busy === "download"}
        >
          <Download size={13} />
        </IconButton>
        <IconButton
          title="恢复到此快照"
          onClick={() => void onRestore()}
          spinning={busy === "restore"}
        >
          <RotateCcw size={13} />
        </IconButton>
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{formatWhen(snap.createdAt)}</span>
        <span>·</span>
        <span>{formatBytes(snap.sizeBytes)}</span>
      </div>
    </li>
  );
}

/** Compact local timestamp for a snapshot row (e.g. "06-15 03:04"). */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
