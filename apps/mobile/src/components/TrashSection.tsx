import type { WorkspaceTrashEntry } from "@/api/workspace";
// Cloud AgentCore/trash list + one-click restore (对齐桌面 TrashSection 语义).
//
// The one soft-delete surface on the phone — both file pages route here, so a delete made
// from either is undone in the same place. Not the OS recycle bin; no Local trash / batch /
// hard-delete.
import { useCallback, useEffect, useState } from "react";

/**
 * How to reach one cloud workspace's soft-delete zone.
 *
 * Injected (like `FileBrowserSource`) because the same trash is addressable two ways:
 * `/v1/conversations/{id}/trash` from a chat, `/v1/workspaces/{ws_id}/trash` from the
 * 文件 tab. Callers must keep the object stable (`useMemo`) — it drives the reload effect.
 */
export interface TrashSource {
  list: () => Promise<{
    entries: WorkspaceTrashEntry[];
    retentionDays: number;
  }>;
  restore: (entryId: string) => Promise<void>;
}

/**
 * AgentCore/trash list + restore for a cloud workspace.
 *
 * Empty / loading / error+retry; restore confirms then refreshes the list.
 * Parent bumps the file-tree `reloadKey` via `onRestored`.
 */
export function TrashSection({
  source,
  onRestored,
}: {
  source: TrashSource;
  /** After a successful restore — parent should refresh the live file tree. */
  onRestored?: () => void;
}) {
  const [entries, setEntries] = useState<WorkspaceTrashEntry[] | null>(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await source.list();
      setEntries(res.entries);
      setRetentionDays(res.retentionDays);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="trash-section">
      <div className="trash-hint">
        <p className="muted hint">
          工作区软删区（保留约 {retentionDays}{" "}
          天）。云端可逆删除会进入此处；本地系统回收站删除不在此列。
        </p>
        <button
          type="button"
          className="link"
          disabled={loading}
          onClick={() => void reload()}
          aria-label="刷新软删区"
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      {statusMsg && <div className="trash-status">{statusMsg}</div>}

      <div className="list trash-list">
        {error ? (
          <div className="trash-error">
            <p className="muted hint">加载软删区失败</p>
            <button
              type="button"
              className="retry-btn"
              onClick={() => void reload()}
            >
              重试
            </button>
          </div>
        ) : entries === null ? (
          <p className="muted hint">加载中…</p>
        ) : entries.length === 0 ? (
          <p className="muted hint">
            软删区为空。云端可逆删除会进入此处；可用「还原」放回原路径。
          </p>
        ) : (
          <ul className="trash-entries">
            {entries.map((e) => (
              <TrashRow
                key={e.entryId}
                restore={source.restore}
                entry={e}
                onRestored={() => {
                  setStatusMsg("已还原");
                  void reload();
                  onRestored?.();
                }}
                onError={(msg) => setStatusMsg(msg)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TrashRow({
  restore,
  entry,
  onRestored,
  onError,
}: {
  restore: (entryId: string) => Promise<void>;
  entry: WorkspaceTrashEntry;
  onRestored: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const onRestore = async () => {
    if (busy) return;
    if (!window.confirm(`还原「${entry.originalPath}」到原路径？`)) return;
    setBusy(true);
    try {
      await restore(entry.entryId);
      onRestored();
    } catch (e) {
      onError(e instanceof Error ? `还原失败：${e.message}` : "还原失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="trash-row">
      <div className="trash-row-meta">
        <div className="trash-row-name">{entry.name}</div>
        <div className="trash-row-path muted">
          {entry.originalPath}
          {entry.isDir ? "（目录）" : ""}
        </div>
      </div>
      <button
        type="button"
        className="link trash-restore"
        disabled={busy}
        onClick={() => void onRestore()}
        aria-label={`还原 ${entry.name}`}
      >
        {busy ? "还原中…" : "还原"}
      </button>
    </li>
  );
}
