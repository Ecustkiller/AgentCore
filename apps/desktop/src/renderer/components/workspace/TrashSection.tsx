import { Centered, EmptyHint, InlineError } from "@/components/files/parts";
import { IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { notifyActionError, notifySuccess } from "@/lib/toast";
import {
  type WorkspaceTrashEntry,
  listTrash,
  restoreTrash,
} from "@/services/workspace";
import { Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * AgentCore/trash list + one-click restore (cloud REST).
 *
 * Local OS recycle-bin deletes are a separate track — never listed here.
 * Local no-OS-trash fallback uses desktop IPC (see LocalTrashSection).
 */
export function TrashSection({ conversationId }: { conversationId: string }) {
  const [entries, setEntries] = useState<WorkspaceTrashEntry[] | null>(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await listTrash(conversationId);
      setEntries(res.entries);
      setRetentionDays(res.retentionDays);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          工作区软删区（保留约 {retentionDays}{" "}
          天）。本地系统回收站删除不在此列，请在本机回收站恢复。
        </p>
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
        {error ? (
          <InlineError onRetry={() => void reload()} />
        ) : entries === null ? (
          <Centered>
            <Loader2
              size={18}
              className="animate-spin text-muted-foreground/50"
            />
          </Centered>
        ) : entries.length === 0 ? (
          <EmptyHint
            inline
            icon={<Trash2 size={22} className="text-muted-foreground/40" />}
            title="软删区为空"
            hint="云端可逆删除会进入此处；可用「还原」放回原路径。"
          />
        ) : (
          <ul className="space-y-1">
            {entries.map((e) => (
              <TrashRow
                key={e.entryId}
                conversationId={conversationId}
                entry={e}
                onRestored={() => void reload()}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Local AgentCore/trash (no-OS-trash fallback). OS shell.trashItem is not listed.
 */
export function LocalTrashSection({ rootId }: { rootId: string }) {
  const [entries, setEntries] = useState<WorkspaceTrashEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await window.fsApi.listWorkspaceTrash(rootId);
      if (!res.ok) {
        setError(true);
        setEntries([]);
        return;
      }
      setEntries(
        res.data.map((e) => ({
          entryId: e.entryId,
          originalPath: e.originalPath,
          name: e.name,
          isDir: e.isDir,
          deletedAt: e.deletedAt,
        })),
      );
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [rootId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          仅列出工作区软删兜底（无系统回收站时）。经系统回收站删除的文件请在本机回收站恢复——产品不提供一键还原。
        </p>
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
        {error ? (
          <InlineError onRetry={() => void reload()} />
        ) : entries === null ? (
          <Centered>
            <Loader2
              size={18}
              className="animate-spin text-muted-foreground/50"
            />
          </Centered>
        ) : entries.length === 0 ? (
          <EmptyHint
            inline
            icon={<Trash2 size={22} className="text-muted-foreground/40" />}
            title="工作区软删区为空"
            hint="默认删除进系统回收站；仅当无系统回收站时才会落入此处。"
          />
        ) : (
          <ul className="space-y-1">
            {entries.map((e) => (
              <LocalTrashRow
                key={e.entryId}
                rootId={rootId}
                entry={e}
                onRestored={() => void reload()}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TrashRow({
  conversationId,
  entry,
  onRestored,
}: {
  conversationId: string;
  entry: WorkspaceTrashEntry;
  onRestored: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const onRestore = async () => {
    if (busy) return;
    if (!window.confirm(`还原「${entry.originalPath}」到原路径？`)) return;
    setBusy(true);
    try {
      await restoreTrash(conversationId, entry.entryId);
      notifySuccess("已还原");
      onRestored();
    } catch (e) {
      notifyActionError("还原失败", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-border px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{entry.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {entry.originalPath}
            {entry.isDir ? "（目录）" : ""}
          </div>
        </div>
        <SimpleTooltip label="还原到原路径">
          <IconButton
            disabled={busy}
            onClick={() => void onRestore()}
            aria-label="还原"
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RotateCcw size={14} />
            )}
          </IconButton>
        </SimpleTooltip>
      </div>
    </li>
  );
}

function LocalTrashRow({
  rootId,
  entry,
  onRestored,
}: {
  rootId: string;
  entry: WorkspaceTrashEntry;
  onRestored: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const onRestore = async () => {
    if (busy) return;
    if (!window.confirm(`还原「${entry.originalPath}」到原路径？`)) return;
    setBusy(true);
    try {
      const res = await window.fsApi.restoreWorkspaceTrash(
        rootId,
        entry.entryId,
      );
      if (!res.ok) {
        notifyActionError("还原失败", new Error(res.reason));
        return;
      }
      notifySuccess("已还原");
      onRestored();
    } catch (e) {
      notifyActionError("还原失败", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-border px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{entry.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {entry.originalPath}
            {entry.isDir ? "（目录）" : ""}
          </div>
        </div>
        <SimpleTooltip label="还原到原路径">
          <IconButton
            disabled={busy}
            onClick={() => void onRestore()}
            aria-label="还原"
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RotateCcw size={14} />
            )}
          </IconButton>
        </SimpleTooltip>
      </div>
    </li>
  );
}
