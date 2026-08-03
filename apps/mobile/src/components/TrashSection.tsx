import {
  type WorkspaceTrashEntry,
  listTrash,
  restoreTrash,
} from "@/api/workspace";
// Cloud AgentCore/trash list + one-click restore (对齐桌面 TrashSection 语义).
//
// Conversation FilesPage only — not OS recycle bin, no Local trash / batch / hard-delete.
import { useCallback, useEffect, useState } from "react";

/**
 * AgentCore/trash list + restore for a conversation cloud workspace.
 *
 * Empty / loading / error+retry; restore confirms then refreshes the list.
 * Parent bumps the file-tree `reloadKey` via `onRestored`.
 */
export function TrashSection({
  conversationId,
  onRestored,
}: {
  conversationId: string;
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
                conversationId={conversationId}
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
  conversationId,
  entry,
  onRestored,
  onError,
}: {
  conversationId: string;
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
      await restoreTrash(conversationId, entry.entryId);
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
