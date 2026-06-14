import {
  type EntryKind,
  type IndexedEntry,
  buildDirListing,
  filterEntries,
  loadFileIndex,
} from "@/lib/fileIndex";
import { api } from "@/services/api";
import { moveConversation } from "@/services/conversations";
import type { OutgoingAttachment } from "@/services/streamConversation";
import { sendTurn } from "@/services/turns";
import {
  getActiveRuntime,
  useActiveGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import { Folder, Paperclip, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MentionMenu } from "./MentionMenu";

/** 已选附件（含正文，仅发送时携带；气泡只展示元信息）。 */
interface PendingAttachment {
  id: string;
  /** kind:rootId:relPath，用于去重。 */
  key: string;
  name: string;
  path: string;
  /** 文件为正文；目录为「文件清单」文本。仅发送时携带，不入库。 */
  text: string;
  truncated: boolean;
  /** file=单文件正文；dir=目录文件清单。 */
  kind: EntryKind;
}

type MenuMode = "mention" | "browse" | null;

/** 从光标向前回溯定位 `@token`：要求 `@` 在行首或空白后，且其后无空白。 */
function detectMention(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  let at = -1;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      at = i;
      break;
    }
    if (ch === " " || ch === "\n" || ch === "\t") return null;
  }
  if (at === -1) return null;
  const before = at === 0 ? "" : text[at - 1];
  if (before && !/\s/.test(before)) return null;
  return { start: at, query: text.slice(at + 1, caret) };
}

export function MessageInput() {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isGenerating = useActiveGenerating();
  const addMessage = useConversationStore((s) => s.addMessage);
  const renameConversation = useConversationStore((s) => s.renameConversation);
  const navigate = useNavigate();

  // ---- @ 提及 / 文件浏览菜单 ----
  const [menuMode, setMenuMode] = useState<MenuMode>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [fileIndex, setFileIndex] = useState<IndexedEntry[]>([]);
  const [dirIndex, setDirIndex] = useState<IndexedEntry[]>([]);
  const [rootCount, setRootCount] = useState(0);
  const [indexLoading, setIndexLoading] = useState(false);
  const indexLoadedRef = useRef(false);
  const mentionRangeRef = useRef<{ start: number; end: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 合并目录与文件并按路径排序：空 query 时目录与其内容相邻，便于发现「@ 目录」。
  const entries = useMemo(
    () =>
      [...dirIndex, ...fileIndex].sort((a, b) =>
        a.display.localeCompare(b.display, "zh"),
      ),
    [dirIndex, fileIndex],
  );
  const items = useMemo(() => filterEntries(entries, query), [entries, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: query/menuMode are intentional re-run keys — reset the highlighted item whenever the query or menu mode changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, menuMode]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: value is an intentional re-run key — re-measure the textarea height on every input change.
  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const ensureIndex = useCallback(async () => {
    if (indexLoadedRef.current) return;
    setIndexLoading(true);
    try {
      const { files, dirs, rootCount: count } = await loadFileIndex();
      setFileIndex(files);
      setDirIndex(dirs);
      setRootCount(count);
      indexLoadedRef.current = true;
    } catch {
      setMenuError("读取文件列表失败");
    } finally {
      setIndexLoading(false);
    }
  }, []);

  const closeMenu = useCallback(() => {
    setMenuMode(null);
    setMenuError(null);
    mentionRangeRef.current = null;
  }, []);

  const openMention = useCallback(
    (start: number, end: number, q: string) => {
      mentionRangeRef.current = { start, end };
      setQuery(q);
      setMenuMode("mention");
      setMenuError(null);
      void ensureIndex();
    },
    [ensureIndex],
  );

  const openBrowse = useCallback(() => {
    if (menuMode === "browse") {
      closeMenu();
      return;
    }
    mentionRangeRef.current = null;
    setQuery("");
    setMenuMode("browse");
    setMenuError(null);
    void ensureIndex();
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [menuMode, closeMenu, ensureIndex]);

  /** 根据当前光标位置同步 mention 菜单状态。 */
  const syncMention = useCallback(
    (text: string, caret: number) => {
      const m = detectMention(text, caret);
      if (m) {
        openMention(m.start, caret, m.query);
      } else if (menuMode === "mention") {
        closeMenu();
      }
    },
    [menuMode, openMention, closeMenu],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const text = e.target.value;
      setValue(text);
      syncMention(text, e.target.selectionStart ?? text.length);
    },
    [syncMention],
  );

  const attachEntry = useCallback(
    async (entry: IndexedEntry) => {
      const key = `${entry.kind}:${entry.rootId}:${entry.relPath}`;
      if (attachments.some((a) => a.key === key)) {
        closeMenu();
        textareaRef.current?.focus();
        return;
      }

      let next: PendingAttachment | null = null;
      if (entry.kind === "dir") {
        // 目录：附带「文件清单」（递归相对路径），不读取任何文件正文。
        const listing = buildDirListing(fileIndex, entry);
        if (listing.fileCount === 0) {
          setMenuError("该目录内没有可索引的文件");
          return;
        }
        next = {
          id: crypto.randomUUID(),
          key,
          name: entry.name,
          path: entry.display,
          text: listing.text,
          truncated: listing.truncated,
          kind: "dir",
        };
      } else {
        const res = await window.fsApi.readFile(entry.rootId, entry.relPath);
        if (!res.ok) {
          setMenuError(res.reason);
          return;
        }
        if (res.data.kind !== "text") {
          setMenuError(
            res.data.kind === "image"
              ? "暂不支持图片附件（模型尚无视觉能力）"
              : "二进制文件无法作为文本附件",
          );
          return;
        }
        next = {
          id: crypto.randomUUID(),
          key,
          name: entry.name,
          path: entry.display,
          text: (res.data as { content: string }).content,
          truncated: (res.data as { truncated: boolean }).truncated,
          kind: "file",
        };
      }

      const attachment = next;
      setAttachments((prev) => [...prev, attachment]);

      // mention 模式：把已消费的 `@query` 从文本中移除。
      const range = mentionRangeRef.current;
      if (menuMode === "mention" && range) {
        const updated = value.slice(0, range.start) + value.slice(range.end);
        setValue(updated);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.selectionStart = el.selectionEnd = range.start;
          }
        });
      } else {
        textareaRef.current?.focus();
      }
      closeMenu();
    },
    [attachments, fileIndex, value, menuMode, closeMenu],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleAddRoot = useCallback(async () => {
    const root = await window.fsApi.addRoot();
    if (!root) return;
    indexLoadedRef.current = false;
    await ensureIndex();
  }, [ensureIndex]);

  const stopGeneration = useCallback(() => {
    useConversationStore.getState().stopGeneration();
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || isGenerating) return;

    const pending = attachments;
    const store = useConversationStore.getState();
    const isFirstMessage = getActiveRuntime().messages.length === 0;

    let conversationId = store.currentConversationId;
    let createdNew = false;
    if (!conversationId) {
      // A draft started from a folder header files itself into that folder.
      const targetFolderId = useFoldersStore.getState().pendingNewChatFolderId;
      try {
        const conv = await api.post<{ id: string }>("/v1/conversations", {
          title: null,
        });
        conversationId = conv.id;
        useConversationStore.getState().setConversations([
          {
            id: conv.id,
            title: "新对话",
            updatedAt: new Date().toISOString(),
            messageCount: 0,
            lastMessagePreview: null,
            folderId: targetFolderId,
          },
          ...useConversationStore.getState().conversations,
        ]);
        useConversationStore.getState().setCurrentConversation(conv.id);
        createdNew = true;
        if (targetFolderId) {
          useFoldersStore.getState().setPendingNewChatFolder(null);
          void moveConversation(conv.id, targetFolderId).catch(() => {
            // Membership is cosmetic for an empty new chat; on failure it just
            // stays ungrouped until the next reload reconciles it.
            useConversationStore
              .getState()
              .setConversationFolder(conv.id, null);
          });
        }
      } catch {
        return;
      }
    }

    const userMsgId = crypto.randomUUID();
    addMessage({
      id: userMsgId,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
      executionId: null,
      isStreaming: false,
      attachments: pending.length
        ? pending.map((a) => ({
            id: a.id,
            name: a.name,
            path: a.path,
            truncated: a.truncated,
            kind: a.kind,
          }))
        : undefined,
    });
    setValue("");
    setAttachments([]);
    closeMenu();

    if (isFirstMessage) {
      const title = trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed;
      renameConversation(conversationId, title);
    }

    // 新建会话发送后切到带 id 的路由，保证「刚建会话直接刷新」也能从历史恢复。
    // 此前已 setCurrentConversation + addMessage，故 ConversationPage 守卫
    // （id===current 不清空、messages.length>0 不覆盖）会保住这条乐观消息。
    if (createdNew) {
      navigate(`/conversations/${conversationId}`);
    }

    const outgoing: OutgoingAttachment[] = pending.map((a) => ({
      name: a.name,
      path: a.path,
      text: a.text,
      truncated: a.truncated,
      kind: a.kind,
    }));

    await sendTurn({
      conversationId,
      content: trimmed,
      attachments: outgoing,
      optimisticUserId: userMsgId,
    });
  }, [
    value,
    attachments,
    isGenerating,
    addMessage,
    renameConversation,
    navigate,
    closeMenu,
  ]);

  useEffect(() => {
    return () => {
      getActiveRuntime().abort?.abort();
    };
  }, []);

  /** 菜单开启时拦截导航键；返回 true 表示已消费。 */
  const handleMenuNavKey = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!menuMode) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
          return true;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return true;
        case "Enter":
          if (items[activeIndex]) {
            e.preventDefault();
            void attachEntry(items[activeIndex]);
            return true;
          }
          return false;
        case "Tab":
          if (items[activeIndex]) {
            e.preventDefault();
            void attachEntry(items[activeIndex]);
            return true;
          }
          return false;
        case "Escape":
          e.preventDefault();
          closeMenu();
          textareaRef.current?.focus();
          return true;
        default:
          return false;
      }
    },
    [menuMode, items, activeIndex, attachEntry, closeMenu],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (menuMode === "mention" && handleMenuNavKey(e)) return;

    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setValue((v) => `${v}\n`);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const charCount = value.length;
  const menuOpen = menuMode !== null;

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="relative rounded-xl border border-border bg-card shadow-sm">
        {menuOpen && (
          <MentionMenu
            items={items}
            activeIndex={activeIndex}
            loading={indexLoading}
            error={menuError}
            query={query}
            showSearch={menuMode === "browse"}
            noRoots={indexLoadedRef.current && rootCount === 0}
            onQueryChange={setQuery}
            onKeyDown={(e) => {
              handleMenuNavKey(e);
            }}
            onSelect={(entry) => void attachEntry(entry)}
            onHover={setActiveIndex}
            onAddRoot={handleAddRoot}
            searchInputRef={searchInputRef}
          />
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.map((a) => (
              <span
                key={a.id}
                title={a.path}
                className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg bg-accent px-2 py-1 text-xs text-accent-foreground"
              >
                {a.kind === "dir" ? (
                  <Folder size={12} className="shrink-0" />
                ) : (
                  <Paperclip size={12} className="shrink-0" />
                )}
                <span className="truncate">
                  {a.name}
                  {a.kind === "dir" ? "/" : ""}
                </span>
                {a.truncated && (
                  <span className="shrink-0 text-muted-foreground">
                    {a.kind === "dir" ? "部分" : "已截断"}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label="移除附件"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={(e) =>
            syncMention(
              e.currentTarget.value,
              e.currentTarget.selectionStart ?? 0,
            )
          }
          placeholder="输入消息，@ 引用文件…"
          disabled={isGenerating}
          className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
          rows={1}
        />
        <div className="flex items-center justify-between px-4 pb-3">
          <button
            type="button"
            onClick={openBrowse}
            disabled={isGenerating}
            aria-label="附加文件"
            className={`flex size-8 items-center justify-center rounded-lg hover:bg-accent disabled:opacity-40 ${
              menuMode === "browse"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground"
            }`}
          >
            <Paperclip size={16} />
          </button>
          <div className="flex items-center gap-3">
            {charCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {charCount}字
              </span>
            )}
            {isGenerating ? (
              <button
                type="button"
                onClick={stopGeneration}
                className="flex size-8 items-center justify-center rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!value.trim()}
                className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
