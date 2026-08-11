import { Centered, EmptyHint, InlineError } from "@/components/files/parts";
import { Button, IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  classifySnapshotLabel,
  groupSnapshotsByKind,
  snapshotDisplayHint,
  snapshotDisplayTitle,
} from "@/components/workspace/snapshotDisplay";
import { formatBytes } from "@/lib/format";
import { notifyActionError, notifyError } from "@/lib/toast";
import {
  type WorkspaceSnapshot,
  createSnapshot,
  downloadSnapshot,
  listSnapshots,
  restoreSnapshot,
} from "@/services/workspace";
import { useAutoSnapshotStore } from "@/stores/autoSnapshot";
import {
  Camera,
  Download,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
  const autoSnapshotFailed = useAutoSnapshotStore((s) =>
    Boolean(s.failedByConversation[conversationId]),
  );

  const trimmedLabel = label.trim();
  const canCreate = trimmedLabel.length > 0 && !creating;

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
    if (!canCreate) return;
    setCreating(true);
    try {
      await createSnapshot(conversationId, trimmedLabel);
      setLabel("");
      await reload();
    } catch (e) {
      notifyError(e, "留版本失败");
    } finally {
      setCreating(false);
    }
  };

  const grouped = snaps ? groupSnapshotsByKind(snaps) : null;

  return (
    <div className="flex h-full flex-col">
      {autoSnapshotFailed ? (
        <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          最近一次自动备份失败。回合已正常完成；可手动留版本，或等下次改文件回合重试。
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onCreate();
          }}
          placeholder="版本名"
          maxLength={200}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
        />
        <SimpleTooltip label="为当前工作区留一个命名版本（不会被自动清理）">
          <Button
            className="shrink-0 disabled:opacity-60"
            disabled={!canCreate}
            onClick={() => void onCreate()}
            icon={
              creating ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Camera size={13} />
              )
            }
          >
            留版本
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="刷新">
          <IconButton
            disabled={loading}
            onClick={() => void reload()}
            aria-label="刷新"
          >
            {loading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
          </IconButton>
        </SimpleTooltip>
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
            hint="改动文件的回合结束后会自动备份；也可随时手动留一个命名版本。"
          />
        ) : (
          <div className="space-y-3">
            <SnapshotGroup
              title="留存版本"
              snaps={grouped?.kept ?? []}
              conversationId={conversationId}
              onRestored={() => void reload()}
            />
            <SnapshotGroup
              title="自动备份"
              snaps={grouped?.auto ?? []}
              conversationId={conversationId}
              onRestored={() => void reload()}
            />
            <SnapshotGroup
              title="系统快照"
              snaps={grouped?.system ?? []}
              conversationId={conversationId}
              onRestored={() => void reload()}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function SnapshotGroup({
  title,
  snaps,
  conversationId,
  onRestored,
}: {
  title: string;
  snaps: WorkspaceSnapshot[];
  conversationId: string;
  onRestored: () => void;
}) {
  if (snaps.length === 0) return null;
  return (
    <section>
      <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-1">
        {snaps.map((s) => (
          <SnapshotRow
            key={s.snapshotId}
            conversationId={conversationId}
            snap={s}
            onRestored={onRestored}
          />
        ))}
      </ul>
    </section>
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
  const kind = classifySnapshotLabel(snap.label);
  const title = snapshotDisplayTitle(snap.label);
  const hint = snapshotDisplayHint(snap.label);

  const onDownload = async () => {
    if (busy) return;
    setBusy("download");
    try {
      await downloadSnapshot(conversationId, snap.snapshotId);
    } catch (e) {
      notifyActionError("下载快照失败", e);
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
    } catch (e) {
      notifyError(e, "恢复快照失败");
    } finally {
      setBusy(null);
    }
  };

  const titleClass =
    kind === "auto" || kind === "system"
      ? "min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground"
      : "min-w-0 flex-1 truncate text-xs font-medium";

  return (
    <li className="rounded-lg border border-border px-2.5 py-2">
      <div className="flex items-center gap-2">
        {hint ? (
          <SimpleTooltip label={hint}>
            <span className={titleClass}>{title}</span>
          </SimpleTooltip>
        ) : (
          <span className={titleClass}>{title}</span>
        )}
        <SimpleTooltip label="下载快照 (zip)">
          <IconButton
            disabled={busy === "download"}
            onClick={() => void onDownload()}
            aria-label="下载快照 (zip)"
          >
            {busy === "download" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
          </IconButton>
        </SimpleTooltip>
        <SimpleTooltip label="恢复到此快照">
          <IconButton
            disabled={busy === "restore"}
            onClick={() => void onRestore()}
            aria-label="恢复到此快照"
          >
            {busy === "restore" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RotateCcw size={13} />
            )}
          </IconButton>
        </SimpleTooltip>
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
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
