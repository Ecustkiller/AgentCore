import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getConversations } from "@/hooks/useConversations";
import { jumpToMessage } from "@/services/messages";
import {
  type SearchItem,
  type SearchSectionType,
  searchAll,
} from "@/services/search";
import { useConversationStore } from "@/stores/conversation";
import { useUIStore } from "@/stores/ui";
import { Command } from "cmdk";
import { Folder, Loader2, MessageSquare, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

/** Per-section cap, and the recent-conversations count for the empty query. */
const PER_TYPE_LIMIT = 8;
/** Wait this long after the last keystroke before hitting the backend. */
const DEBOUNCE_MS = 300;

/** A rendered group: an entity type and its hits (reused for the empty-query
 * "recent conversations" list, which is built client-side). */
interface UISection {
  type: SearchSectionType;
  items: SearchItem[];
}

/** A selectable row, flattened across sections for single-axis keyboard nav. */
interface FlatEntry {
  type: SearchSectionType;
  item: SearchItem;
}

const SECTION_LABEL: Record<SearchSectionType, string> = {
  conversation: "对话",
  message: "消息",
  folder: "文件夹",
};

const SECTION_ICON: Record<SearchSectionType, typeof MessageSquare> = {
  conversation: MessageSquare,
  message: MessageSquare,
  folder: Folder,
};

/** Slice a snippet around its match offsets for highlighting; falls back to the
 * plain text when the offsets are missing or out of range. */
function Snippet({ item }: { item: SearchItem }) {
  const text = item.snippet ?? "";
  const start = item.match_start;
  const end = item.match_end;
  if (
    start == null ||
    end == null ||
    start < 0 ||
    end > text.length ||
    start >= end
  ) {
    return <span className="truncate text-muted-foreground">{text}</span>;
  }
  return (
    <span className="truncate text-muted-foreground">
      {text.slice(0, start)}
      <mark className="bg-primary/20 text-foreground">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </span>
  );
}

/**
 * Global command palette (Ctrl/Cmd+K) — Tier 1 global search.
 *
 * An empty query shows recent conversations (client-side, from the store, 决策④);
 * one or more characters runs a debounced backend keyword search across the
 * user's conversations, messages and folders, grouped by type. cmdk owns the
 * ↑/↓/Enter navigation and active-item scrolling (filtering disabled — results
 * come from the backend). Jumps: conversation → open it;
 * message → open + scroll-to-message (load-around for hits outside the window,
 * 命中必达); folder → reveal it in the sidebar.
 */
export function CommandPalette() {
  const open = useUIStore((s) => s.searchOpen);
  const close = useUIStore((s) => s.closeSearch);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [sections, setSections] = useState<UISection[]>([]);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against out-of-order responses: only the latest keystroke's result
  // is adopted (debounce keeps the request count low, so no abort needed).
  const seqRef = useRef(0);

  // Each open is a fresh search: clear the query and reset the cursor. (Input
  // focus is handled by the dialog's onOpenAutoFocus.)
  useEffect(() => {
    if (!open) return;
    setQuery("");
  }, [open]);

  // Resolve the query to grouped results: empty → recent conversations (local);
  // non-empty → debounced backend search. Gated on `open` so it recomputes the
  // recent list each time the palette opens (and does nothing while closed).
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length === 0) {
      seqRef.current++;
      setLoading(false);
      setErrored(false);
      const recent = getConversations()
        .slice(0, PER_TYPE_LIMIT)
        .map((c) => ({ id: c.id, title: c.title }) as SearchItem);
      setSections(
        recent.length ? [{ type: "conversation", items: recent }] : [],
      );
      return;
    }
    setLoading(true);
    setErrored(false);
    const seq = ++seqRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await searchAll(q, { limit: PER_TYPE_LIMIT });
          if (seq !== seqRef.current) return;
          setSections(res.sections as UISection[]);
          setLoading(false);
        } catch {
          if (seq !== seqRef.current) return;
          setSections([]);
          setErrored(true);
          setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open]);

  // Flattened only to detect "no results"; cmdk owns cursor/keyboard/scroll.
  const flat = useMemo<FlatEntry[]>(
    () =>
      sections.flatMap((s) => s.items.map((item) => ({ type: s.type, item }))),
    [sections],
  );

  const openConversation = (id: string) => {
    switchConversation(id);
    navigate(`/conversations/${id}`);
    close();
  };

  const openMessage = (item: SearchItem) => {
    const conversationId = item.conversation_id;
    if (!conversationId) return;
    const store = useConversationStore.getState();
    const already = store.currentConversationId === conversationId;
    store.switchConversation(conversationId);
    navigate(`/conversations/${conversationId}`);
    close();
    if (already) {
      // Same conversation already open: navigate is a no-op, so jump now.
      void jumpToMessage(conversationId, item.id);
    } else {
      // Opening fresh: let ConversationPage load its window, then honor this.
      store.requestMessageFocus(conversationId, item.id);
    }
  };

  const openFolder = (id: string) => {
    // Folders moved out of the sidebar onto the /conversations management page.
    // Jump there and pass the folder via navigation state so the page selects
    // and flashes it (mirrors a conversation/message hit landing on its target).
    navigate("/conversations", { state: { focusFolderId: id } });
    close();
  };

  const execute = (entry: FlatEntry) => {
    if (entry.type === "conversation") openConversation(entry.item.id);
    else if (entry.type === "message") openMessage(entry.item);
    else openFolder(entry.item.id);
  };

  const isEmptyQuery = query.trim().length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent
        position="top"
        showClose={false}
        className="max-w-xl"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">全局搜索</DialogTitle>
        <Command
          label="全局搜索"
          shouldFilter={false}
          loop
          className="flex flex-col overflow-hidden"
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Search size={16} className="shrink-0 text-muted-foreground" />
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder="搜索对话、消息、文件夹…"
              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            {loading && (
              <Loader2
                size={14}
                className="shrink-0 animate-spin text-muted-foreground"
              />
            )}
            <kbd className="shrink-0 text-xs text-muted-foreground">Esc</kbd>
          </div>

          <Command.List className="max-h-96 overflow-y-auto py-1.5">
            {flat.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {errored
                  ? "搜索失败，请重试"
                  : loading
                    ? "搜索中…"
                    : isEmptyQuery
                      ? "还没有对话"
                      : "没有匹配结果"}
              </div>
            ) : (
              sections.map((section) => {
                const Icon = SECTION_ICON[section.type];
                const isMessage = section.type === "message";
                return (
                  <Command.Group
                    key={section.type}
                    heading={
                      isEmptyQuery && section.type === "conversation"
                        ? "最近对话"
                        : SECTION_LABEL[section.type]
                    }
                    className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/70"
                  >
                    {section.items.map((item) => (
                      <Command.Item
                        key={`${section.type}:${item.id}`}
                        value={`${section.type}:${item.id}`}
                        onSelect={() => execute({ type: section.type, item })}
                        className="flex cursor-pointer items-center gap-3 px-4 py-2 text-foreground transition-colors data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                      >
                        <Icon
                          size={16}
                          className="shrink-0 text-muted-foreground"
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm">
                            {item.title || "未命名"}
                          </span>
                          {isMessage && item.snippet && (
                            <span className="flex text-xs">
                              <Snippet item={item} />
                            </span>
                          )}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              })
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
