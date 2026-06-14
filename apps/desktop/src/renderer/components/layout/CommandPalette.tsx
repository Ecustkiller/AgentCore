import { type Conversation, useConversationStore } from "@/stores/conversation";
import { useUIStore } from "@/stores/ui";
import { MessageSquare, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

const MAX_RESULTS = 8;

/**
 * Global command palette (Ctrl/Cmd+K). MVP scope is conversation search: it
 * filters the already-hydrated conversation list by title client-side — there is
 * no backend search endpoint yet, and the sidebar holds the full list (≤100).
 */
export function CommandPalette() {
  const open = useUIStore((s) => s.searchOpen);
  const close = useUIStore((s) => s.closeSearch);
  const conversations = useConversationStore((s) => s.conversations);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Each open is a fresh search: clear the query, reset the cursor, focus input.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q
      ? conversations.filter((c) => c.title.toLowerCase().includes(q))
      : conversations;
    return pool.slice(0, MAX_RESULTS);
  }, [query, conversations]);

  // Keep the cursor within bounds as the result set shrinks/grows.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  // Follow the keyboard cursor into view.
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  const openConversation = (c: Conversation) => {
    switchConversation(c.id);
    navigate(`/conversations/${c.id}`);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) =>
        results.length ? (i - 1 + results.length) % results.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const sel = results[activeIndex];
      if (sel) openConversation(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; keyboard dismissal is handled by the Escape key on the input.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay px-4 pt-[15vh]"
      onMouseDown={close}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops backdrop dismissal when interacting inside the panel. */}
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search size={16} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索对话…"
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <kbd className="shrink-0 text-xs text-muted-foreground">Esc</kbd>
        </div>

        {results.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {query.trim() ? "没有匹配的对话" : "还没有对话"}
          </div>
        ) : (
          <ul ref={listRef} className="max-h-80 overflow-y-auto py-1.5">
            {results.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => openConversation(c)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
                    i === activeIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground"
                  }`}
                >
                  <MessageSquare
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="flex-1 truncate text-sm">{c.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
