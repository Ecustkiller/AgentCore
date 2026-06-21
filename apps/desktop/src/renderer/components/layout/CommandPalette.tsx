import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getConversations } from "@/hooks/useConversations";
import {
  COMMAND_CATEGORY_ORDER,
  type PaletteCommand,
  buildPaletteCommands,
  commandMatches,
} from "@/lib/paletteCommands";
import { jumpToMessage } from "@/services/messages";
import {
  type SearchItem,
  type SearchSectionType,
  searchAll,
} from "@/services/search";
import { useConversationStore } from "@/stores/conversation";
import { useSidebarStore } from "@/stores/sidebar";
import { useUIStore } from "@/stores/ui";
import { Command } from "cmdk";
import { Folder, Loader2, MessageSquare, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

/** Per-section cap, and the recent-conversations count for the empty query. */
const PER_TYPE_LIMIT = 8;
/** Wait this long after the last keystroke before hitting the backend. */
const DEBOUNCE_MS = 300;

/** Shared row styling (selected state driven by cmdk). */
const ROW_CLASS =
  "flex cursor-pointer items-center gap-3 px-4 py-2 text-foreground transition-colors data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground";

const GROUP_CLASS =
  "[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground/70";

/** A selectable row: a Tier 2 command (local) or an entity search hit (backend). */
type Row =
  | { kind: "command"; cmd: PaletteCommand }
  | { kind: "entity"; type: SearchSectionType; item: SearchItem };

/** A rendered group: a heading and its rows (commands by category, or one
 * entity type — reused for the empty-query "recent conversations" list). */
interface RenderGroup {
  key: string;
  heading: string;
  rows: Row[];
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
 * Global command palette (Ctrl/Cmd+K) — Tier 2: commands + global search.
 *
 * Two result kinds share one list. **Commands** (新建对话 / 跳转页面 / 切换主题
 * 等) are matched client-side from a static registry, so they appear instantly
 * with no round-trip. **Entities** (对话 / 消息 / 文件夹) come from the debounced
 * backend keyword search (Tier 1) for a non-empty query, or the recent
 * conversations list (client-side, 决策④) for an empty one.
 *
 * Ordering: an empty query keeps 最近对话 on top (preserving the quick-switch
 * muscle memory) with commands below; once the user types, matching commands
 * lead and entity hits follow. cmdk owns ↑/↓/Enter navigation and active-item
 * scrolling (its own filtering stays disabled — both kinds are pre-filtered
 * here). Command jumps run the action and close; entity jumps:
 * conversation → open it; message → open + scroll-to-message (load-around for
 * hits outside the window, 命中必达); folder → reveal it on the management page.
 */
export function CommandPalette() {
  const open = useUIStore((s) => s.searchOpen);
  const close = useUIStore((s) => s.closeSearch);
  const theme = useUIStore((s) => s.theme);
  const usageDetail = useUIStore((s) => s.usageDetail);
  const sidebarCollapsed = useSidebarStore((s) => s.collapsed);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [sections, setSections] = useState<
    { type: SearchSectionType; items: SearchItem[] }[]
  >([]);
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

  // Resolve the query to grouped entity results: empty → recent conversations
  // (local); non-empty → debounced backend search. Gated on `open` so it
  // recomputes the recent list each time the palette opens (and does nothing
  // while closed). Commands are resolved separately, below.
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
          setSections(
            res.sections as { type: SearchSectionType; items: SearchItem[] }[],
          );
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

  const isEmptyQuery = query.trim().length === 0;

  // Commands reflect the live UI state (toggle hints, the active theme) and are
  // filtered locally — no backend round-trip, so they show even while a search
  // is in flight or the backend is down.
  const commands = useMemo(
    () =>
      buildPaletteCommands({
        navigate,
        theme,
        usageDetail,
        sidebarCollapsed,
      }),
    [navigate, theme, usageDetail, sidebarCollapsed],
  );
  const matchedCommands = useMemo(
    () => commands.filter((c) => commandMatches(c, query)),
    [commands, query],
  );

  const commandGroups = useMemo<RenderGroup[]>(
    () =>
      COMMAND_CATEGORY_ORDER.map((cat) => ({
        key: `cmd:${cat}`,
        heading: cat,
        rows: matchedCommands
          .filter((c) => c.category === cat)
          .map((c) => ({ kind: "command", cmd: c }) as Row),
      })).filter((g) => g.rows.length > 0),
    [matchedCommands],
  );

  const entityGroups = useMemo<RenderGroup[]>(
    () =>
      sections
        .filter((s) => s.items.length > 0)
        .map((s) => ({
          key: `ent:${s.type}`,
          heading:
            isEmptyQuery && s.type === "conversation"
              ? "最近对话"
              : SECTION_LABEL[s.type],
          rows: s.items.map(
            (item) => ({ kind: "entity", type: s.type, item }) as Row,
          ),
        })),
    [sections, isEmptyQuery],
  );

  // Empty query → recent conversations first (quick-switch), commands after;
  // typing → matching commands first, entity hits after.
  const groups = useMemo<RenderGroup[]>(
    () =>
      isEmptyQuery
        ? [...entityGroups, ...commandGroups]
        : [...commandGroups, ...entityGroups],
    [isEmptyQuery, entityGroups, commandGroups],
  );
  const hasRows = useMemo(
    () => groups.some((g) => g.rows.length > 0),
    [groups],
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

  const runRow = (row: Row) => {
    if (row.kind === "command") {
      row.cmd.run();
      close();
      return;
    }
    if (row.type === "conversation") openConversation(row.item.id);
    else if (row.type === "message") openMessage(row.item);
    else openFolder(row.item.id);
  };

  const rowValue = (row: Row) =>
    row.kind === "command" ? `cmd:${row.cmd.id}` : `${row.type}:${row.item.id}`;

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
        <DialogTitle className="sr-only">全局搜索与命令</DialogTitle>
        <Command
          label="全局搜索与命令"
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
              placeholder="搜索对话、消息、文件夹，或运行命令…"
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
            {!hasRows ? (
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
              groups.map((group) => (
                <Command.Group
                  key={group.key}
                  heading={group.heading}
                  className={GROUP_CLASS}
                >
                  {group.rows.map((row) => {
                    const value = rowValue(row);
                    if (row.kind === "command") {
                      const Icon = row.cmd.icon;
                      return (
                        <Command.Item
                          key={value}
                          value={value}
                          onSelect={() => runRow(row)}
                          className={ROW_CLASS}
                        >
                          <Icon
                            size={16}
                            className="shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {row.cmd.title}
                          </span>
                          {row.cmd.shortcut ? (
                            <kbd className="shrink-0 text-xs text-muted-foreground">
                              {row.cmd.shortcut}
                            </kbd>
                          ) : row.cmd.hint ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {row.cmd.hint}
                            </span>
                          ) : null}
                        </Command.Item>
                      );
                    }
                    const Icon = SECTION_ICON[row.type];
                    const isMessage = row.type === "message";
                    return (
                      <Command.Item
                        key={value}
                        value={value}
                        onSelect={() => runRow(row)}
                        className={ROW_CLASS}
                      >
                        <Icon
                          size={16}
                          className="shrink-0 text-muted-foreground"
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm">
                            {row.item.title || "未命名"}
                          </span>
                          {isMessage && row.item.snippet && (
                            <span className="flex text-xs">
                              <Snippet item={row.item} />
                            </span>
                          )}
                        </span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ))
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
