import {
  type CreateShareOptions,
  type Share,
  createShare,
  listShares,
  revokeShare,
  shareLink,
} from "@/api/sharing";
import { Modal } from "@/components/Modal";
import { copyText } from "@/lib/messageExport";
import { useEffect, useState } from "react";

type ExpiryChoice = CreateShareOptions["expires_in_days"] | "never";

const EXPIRY_OPTIONS: { value: ExpiryChoice; label: string }[] = [
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: "never", label: "永久" },
];

function canSystemShare(): boolean {
  return typeof navigator.share === "function";
}

function expiryCaption(share: Share): string {
  if (!share.expires_at) return "永久";
  return `${new Date(share.expires_at).toLocaleDateString("zh-CN")} 过期`;
}

/**
 * 对话分享 sheet：所见即所享只读链接。新建后复制；已有链接可复制 / 撤销。
 * 有 `navigator.share` 时多一个系统分享，失败则回退复制。
 */
export function ShareConversationSheet({
  conversationId,
  title,
  onClose,
}: {
  conversationId: string;
  title?: string | null;
  onClose: () => void;
}) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [expiry, setExpiry] = useState<ExpiryChoice>(30);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const systemShare = canSystemShare();

  useEffect(() => {
    let cancelled = false;
    listShares(conversationId)
      .then((rows) => {
        if (!cancelled) setShares(rows);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "加载分享链接失败");
        setShares([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const copyLink = async (url: string, okText = "链接已复制") => {
    if (await copyText(url)) setStatus(okText);
    else setError("复制失败");
  };

  const handleCreate = async () => {
    if (creating || shares === null) return;
    setCreating(true);
    setError(null);
    setStatus(null);
    try {
      const options: CreateShareOptions = {
        expires_in_days: expiry === "never" ? null : expiry,
      };
      const share = await createShare(conversationId, options);
      setShares((prev) => [share, ...(prev ?? [])]);
      await copyLink(shareLink(share));
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建分享链接失败");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (share: Share) => {
    if (busyId) return;
    setBusyId(share.id);
    setError(null);
    setShares((prev) => prev?.filter((s) => s.id !== share.id) ?? null);
    try {
      await revokeShare(conversationId, share.id);
      setStatus("已撤销");
    } catch (e) {
      setShares((prev) => [share, ...(prev ?? [])]);
      setError(e instanceof Error ? e.message : "撤销失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleSystemShare = async (url: string) => {
    setError(null);
    try {
      await navigator.share({ url });
    } catch {
      await copyLink(url);
    }
  };

  const heading = title?.trim() ? `分享「${title.trim()}」` : "分享对话";

  return (
    <Modal className="sheet share-sheet" onClose={onClose} label="分享对话">
      <div className="sheet-title">{heading}</div>
      <p className="share-sheet-lead muted">
        分享时的问答快照，之后新消息不会出现，可撤销。
      </p>

      <p className="share-sheet-label">有效期</p>
      <fieldset className="share-expiry" aria-label="有效期">
        {EXPIRY_OPTIONS.map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            className="share-expiry-opt"
            aria-pressed={expiry === opt.value}
            disabled={creating}
            onClick={() => setExpiry(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </fieldset>

      <button
        type="button"
        className="sheet-item"
        disabled={creating || shares === null}
        onClick={() => void handleCreate()}
      >
        {creating
          ? "创建中…"
          : shares && shares.length > 0
            ? "新建分享链接"
            : "创建分享链接"}
      </button>

      {shares === null && !error && (
        <p className="share-sheet-note muted">加载中…</p>
      )}
      {shares && shares.length === 0 && !error && (
        <p className="share-sheet-note muted">还没有分享链接。</p>
      )}
      {shares && shares.length > 0 && (
        <ul className="share-list">
          {shares.map((share) => {
            const url = shareLink(share);
            return (
              <li key={share.id} className="share-card">
                <div className="share-card-url">{url}</div>
                <div className="share-card-meta muted">
                  {expiryCaption(share)}
                </div>
                <div className="share-card-actions">
                  <button
                    type="button"
                    disabled={busyId === share.id}
                    onClick={() => void copyLink(url)}
                  >
                    复制
                  </button>
                  {systemShare && (
                    <button
                      type="button"
                      disabled={busyId === share.id}
                      onClick={() => void handleSystemShare(url)}
                    >
                      系统分享
                    </button>
                  )}
                  <button
                    type="button"
                    className="sheet-danger"
                    disabled={busyId === share.id}
                    onClick={() => void handleRevoke(share)}
                  >
                    撤销
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error && <p className="error share-sheet-note">{error}</p>}
      {status && !error && <p className="share-sheet-note muted">{status}</p>}

      <button
        type="button"
        className="sheet-item sheet-cancel"
        onClick={onClose}
      >
        取消
      </button>
    </Modal>
  );
}
