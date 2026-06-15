import {
  type UserSearchResult,
  messagingErrorMessage,
  searchUsers,
  startDm,
} from "@/services/messaging";
import { useMessagingStore } from "@/stores/messaging";
import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { avatarInitial } from "./chatDisplay";

interface Props {
  open: boolean;
  onClose: () => void;
  onStarted: (chatId: string) => void;
}

/**
 * Start a chat by 任意搜人 (exact-match people search → open dm). The server
 * filters search visibility and gates who-can-DM / blocks, so a refusal here
 * (403 contacts-only, 404 unknown) is surfaced via the shared zh phrasing.
 */
export function NewChatDialog({ open, onClose, onStarted }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Each open is a fresh search.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setError(null);
    setStarting(null);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Debounced exact-match search; the empty query clears results.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const users = await searchUsers(q);
          if (!cancelled) {
            setResults(users);
            setError(null);
          }
        } catch (err) {
          if (!cancelled) {
            setResults([]);
            setError(messagingErrorMessage(err, "搜索失败，请重试"));
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, open]);

  if (!open) return null;

  const handleStart = async (user: UserSearchResult) => {
    setStarting(user.id);
    setError(null);
    try {
      const chat = await startDm(user.id);
      useMessagingStore.getState().upsertChat(chat);
      onStarted(chat.id);
      onClose();
    } catch (err) {
      setError(messagingErrorMessage(err, "无法发起会话"));
      setStarting(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay px-4 pt-[15vh]"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search size={16} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="按用户名或 ID 精确搜索…"
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X size={15} />
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto">
          {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
          {!error && loading && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              搜索中…
            </p>
          )}
          {!error && !loading && !query.trim() && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              输入用户名或 ID 查找联系人
            </p>
          )}
          {!error && !loading && query.trim() && results.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              未找到用户（需精确用户名或 ID）
            </p>
          )}
          {results.length > 0 && (
            <ul className="py-1.5">
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    disabled={starting !== null}
                    onClick={() => void handleStart(u)}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                      {avatarInitial(u.display_name || u.username)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-foreground">
                        {u.display_name || u.username}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        @{u.username}
                      </span>
                    </span>
                    {starting === u.id && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        发起中…
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
