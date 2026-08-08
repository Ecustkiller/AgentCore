import type {
  MentionMenuSection,
  MentionMenuSelectable,
} from "@/components/chat/MentionMenu";
import { getConversations } from "@/hooks/useConversations";
import { hasLocalFiles } from "@/lib/capabilities";
import {
  type IndexedEntry,
  buildDirListing,
  filterEntries,
  loadFileIndex,
} from "@/lib/fileIndex";
import type { FileSource } from "@/lib/fileSource";
import { fetchMessageWindow } from "@/services/messages";
import { useConversationStore } from "@/stores/conversation";
import { useExecutionStore } from "@/stores/execution";
import {
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CONV_MENTION_MSG_LIMIT,
  EMPTY_MENTION_INDEX_LIMIT,
  MAX_AGENT_MENTIONS,
  type MentionSectionId,
  type PendingAgentMention,
  type PendingAttachment,
  buildMentionSources,
  detectMention,
  formatConversationContext,
  parseMentionFilter,
  pickRecentConversations,
} from "./composerAttachments";
import {
  pickLocalFileAttachment,
  stageRootFileAttachment,
} from "./resideAttachment";
import { resolveFolderFromIndexedEntry } from "./resolveAttachmentFolder";
import type { MenuMode } from "./types";

export type AttachmentProjectHint = {
  folderId: string;
  folderName: string;
};

function isAgentItem(
  item: MentionMenuSelectable,
): item is { kind: "agent"; agentId: string; role: string } {
  return "kind" in item && item.kind === "agent" && "agentId" in item;
}

/** 从当前会话由近及远找最新带 agents 的 execution（诚实降级：无则空）。 */
function pickTeamAgents(
  messages: ReadonlyArray<{ id: string; role: string }>,
  byId: ReturnType<typeof useExecutionStore.getState>["byId"],
): { id: string; role: string }[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const agents = byId[m.id]?.plan?.agents;
    if (agents && agents.length > 0) {
      return agents.map((a) => ({ id: a.id, role: a.role }));
    }
  }
  return [];
}

const EMPTY_MESSAGES: { id: string; role: string }[] = [];

export function useMentionMenu({
  conversationId,
  value,
  setValue,
  attachments,
  setAttachments,
  agentMentions,
  setAgentMentions,
  textareaRef,
  onAttachmentProjectHint,
}: {
  conversationId: string | null;
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  attachments: PendingAttachment[];
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  agentMentions: PendingAgentMention[];
  setAgentMentions: Dispatch<SetStateAction<PendingAgentMention[]>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Draft-only: @ / browse attach from a project → suggest filing into it (B4). */
  onAttachmentProjectHint?: (hint: AttachmentProjectHint) => void;
}) {
  const [menuMode, setMenuMode] = useState<MenuMode>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [fileIndex, setFileIndex] = useState<IndexedEntry[]>([]);
  const [dirIndex, setDirIndex] = useState<IndexedEntry[]>([]);
  const [sourceCount, setSourceCount] = useState(0);
  const [indexLoading, setIndexLoading] = useState(false);
  const [convTick, setConvTick] = useState(0);
  const indexLoadedRef = useRef(false);
  const sourcesRef = useRef<Map<string, FileSource>>(new Map());
  const mentionRangeRef = useRef<{ start: number; end: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const messages = useConversationStore((s) => {
    if (!conversationId) return EMPTY_MESSAGES;
    return s.byId[conversationId]?.messages ?? EMPTY_MESSAGES;
  });
  const execById = useExecutionStore((s) => s.byId);

  const teamAgents = useMemo(
    () => pickTeamAgents(messages, execById),
    [messages, execById],
  );

  const { section: sectionFilter, filter: filterText } = useMemo(
    () => parseMentionFilter(query),
    [query],
  );

  // 缓存列表变动时（发送/新建）刷新对话分区；tick 作轻量失效键。
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is an intentional re-run key
  useEffect(() => {
    if (!menuMode) return;
    setConvTick((n) => n + 1);
  }, [menuMode, conversationId]);

  const convItems = useMemo(() => {
    void convTick;
    if (menuMode === "browse" && !filterText.trim() && !sectionFilter) {
      // browse 空搜不强推对话；有过滤词或类型前缀时再出。
      if (!query.trim()) return [];
    }
    return pickRecentConversations(
      getConversations(),
      conversationId,
      filterText,
      EMPTY_MENTION_INDEX_LIMIT,
    );
  }, [convTick, menuMode, filterText, sectionFilter, query, conversationId]);

  const emptyLimit = sectionFilter === null ? EMPTY_MENTION_INDEX_LIMIT : 50;

  const folderItems = useMemo(() => {
    const dirs = filterEntries(dirIndex, filterText, emptyLimit);
    return dirs;
  }, [dirIndex, filterText, emptyLimit]);

  const fileItems = useMemo(() => {
    const files = filterEntries(fileIndex, filterText, emptyLimit);
    return files;
  }, [fileIndex, filterText, emptyLimit]);

  const agentItems = useMemo((): MentionMenuSelectable[] => {
    const q = filterText.trim().toLowerCase();
    let agents = teamAgents;
    if (q) {
      agents = agents.filter(
        (a) =>
          a.role.toLowerCase().includes(q) || a.id.toLowerCase().includes(q),
      );
    }
    return agents.map((a) => ({
      kind: "agent" as const,
      agentId: a.id,
      role: a.role,
    }));
  }, [teamAgents, filterText]);

  const sections = useMemo((): MentionMenuSection[] => {
    const show = (id: MentionSectionId) =>
      sectionFilter === null || sectionFilter === id;

    const out: MentionMenuSection[] = [];

    // browse：不强推团队空态；mention 始终可出团队分区。
    if (menuMode === "mention" && show("team")) {
      out.push({
        id: "team",
        label: "团队",
        items: agentItems,
        emptyHint:
          agentItems.length === 0 ? "多 Agent 回合后可点名" : undefined,
      });
    } else if (menuMode === "browse" && show("team") && agentItems.length > 0) {
      out.push({ id: "team", label: "团队", items: agentItems });
    }

    if (
      show("conversation") &&
      (convItems.length > 0 || sectionFilter === "conversation")
    ) {
      out.push({
        id: "conversation",
        label: "对话",
        items: convItems,
      });
    }

    if (show("folder")) {
      out.push({
        id: "folder",
        label: "文件夹",
        items: folderItems,
      });
    }

    if (show("file")) {
      out.push({
        id: "file",
        label: "文件",
        items: fileItems,
      });
    }

    return out;
  }, [menuMode, sectionFilter, agentItems, convItems, folderItems, fileItems]);

  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: query/menuMode/sections are intentional re-run keys
  useEffect(() => {
    setActiveIndex(0);
  }, [query, menuMode, flatItems.length]);

  const ensureIndex = useCallback(async () => {
    if (indexLoadedRef.current) return;
    setIndexLoading(true);
    try {
      const sources = await buildMentionSources(conversationId);
      sourcesRef.current = new Map(sources.map((s) => [s.id, s]));
      const { files, dirs, sourceCount: count } = await loadFileIndex(sources);
      setFileIndex(files);
      setDirIndex(dirs);
      setSourceCount(count);
      indexLoadedRef.current = true;
    } catch {
      setMenuError("读取文件列表失败");
    } finally {
      setIndexLoading(false);
    }
  }, [conversationId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is an intentional re-run key
  useEffect(() => {
    indexLoadedRef.current = false;
    setFileIndex([]);
    setDirIndex([]);
    setSourceCount(0);
    sourcesRef.current = new Map();
  }, [conversationId]);

  const closeMenu = useCallback(() => {
    setMenuMode(null);
    setMenuError(null);
    mentionRangeRef.current = null;
  }, []);

  const stripMentionQuery = useCallback(() => {
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
  }, [menuMode, value, setValue, textareaRef]);

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

  const selectAgent = useCallback(
    (agentId: string, role: string) => {
      if (agentMentions.some((a) => a.agentId === agentId)) {
        stripMentionQuery();
        closeMenu();
        return;
      }
      if (agentMentions.length >= MAX_AGENT_MENTIONS) {
        setMenuError(`最多点名 ${MAX_AGENT_MENTIONS} 个角色`);
        return;
      }
      setAgentMentions((prev) => [
        ...prev,
        { id: crypto.randomUUID(), agentId, role },
      ]);
      stripMentionQuery();
      closeMenu();
    },
    [agentMentions, setAgentMentions, stripMentionQuery, closeMenu],
  );

  const attachEntry = useCallback(
    async (entry: IndexedEntry) => {
      const key = `${entry.kind}:${entry.sourceId}:${entry.relPath}`;
      if (attachments.some((a) => a.key === key)) {
        stripMentionQuery();
        closeMenu();
        return;
      }

      let next: PendingAttachment | null = null;
      if (entry.kind === "conversation") {
        let win: Awaited<ReturnType<typeof fetchMessageWindow>>;
        try {
          win = await fetchMessageWindow(entry.relPath, {
            limit: CONV_MENTION_MSG_LIMIT,
          });
        } catch {
          setMenuError("读取对话失败");
          return;
        }
        const { text, truncated } = formatConversationContext(win.messages);
        if (!text) {
          setMenuError("该对话暂无可引用的内容");
          return;
        }
        next = {
          id: crypto.randomUUID(),
          key,
          name: entry.name,
          path: "对话",
          text,
          truncated: truncated || win.hasMoreBefore,
          kind: "conversation",
          conversationId: entry.relPath,
        };
      } else if (entry.kind === "dir") {
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
        // 文件：引用即驻留——主进程复制进工作区 attachments/（含二进制 xlsx）。
        // 本地根 sourceId = ``local:<rootId>`` 或 ``local:<rootId>:<subpath>``。
        const localMatch = /^local:([^:]+)(?::(.*))?$/.exec(entry.sourceId);
        if (localMatch && hasLocalFiles()) {
          const rootId = localMatch[1];
          const subBase = (localMatch[2] || "").replace(/^\/+|\/+$/g, "");
          const containerRel = subBase
            ? `${subBase}/${entry.relPath}`.replace(/\/+/g, "/")
            : entry.relPath;
          const staged = await stageRootFileAttachment(
            conversationId,
            rootId,
            containerRel,
          );
          if (!staged.ok) {
            setMenuError(staged.reason);
            return;
          }
          next = {
            id: crypto.randomUUID(),
            key,
            name: staged.name,
            path: staged.path,
            text: staged.text,
            truncated: staged.truncated,
            kind: "file",
            workspacePath: staged.workspacePath,
            stagingId: staged.stagingId,
            binary: staged.binary,
          };
        } else {
          const source = sourcesRef.current.get(entry.sourceId);
          if (!source) {
            setMenuError("文件来源已失效，请重试");
            return;
          }
          let res: Awaited<ReturnType<FileSource["read"]>>;
          try {
            res = await source.read(entry.relPath);
          } catch {
            setMenuError("读取文件失败");
            return;
          }
          if (res.kind !== "text") {
            setMenuError(
              res.kind === "too-large"
                ? "文件过大，无法作为附件"
                : "图片或二进制请用回形针 / 拖入附加（将驻留到工作区）",
            );
            return;
          }
          next = {
            id: crypto.randomUUID(),
            key,
            name: entry.name,
            path: entry.display,
            text: res.text,
            truncated: res.truncated,
            kind: "file",
          };
        }
      }

      const attachment = next;
      setAttachments((prev) => [...prev, attachment]);

      if (!conversationId && onAttachmentProjectHint) {
        const resolved = resolveFolderFromIndexedEntry(entry);
        if (resolved) onAttachmentProjectHint(resolved);
      }

      stripMentionQuery();
      closeMenu();
    },
    [
      attachments,
      conversationId,
      fileIndex,
      closeMenu,
      onAttachmentProjectHint,
      setAttachments,
      stripMentionQuery,
    ],
  );

  const selectItem = useCallback(
    (item: MentionMenuSelectable) => {
      if (isAgentItem(item)) {
        selectAgent(item.agentId, item.role);
        return;
      }
      void attachEntry(item);
    },
    [selectAgent, attachEntry],
  );

  const handleAddRoot = useCallback(async () => {
    const picked = await window.fsApi.addRoot();
    if (!picked.ok) return;
    indexLoadedRef.current = false;
    await ensureIndex();
  }, [ensureIndex]);

  /** 回形针 / 菜单：从本机任选文件（含工作区外），主进程驻留。 */
  const pickLocalFile = useCallback(async () => {
    setMenuError(null);
    const res = await pickLocalFileAttachment(conversationId);
    if (res === null) return;
    if (!res.ok) {
      setMenuError(res.reason);
      // 回形针直开选择器时菜单可能未开——仍把错误挂在 menuError，并确保 browse 可见。
      if (!menuMode) {
        setMenuMode("browse");
        mentionRangeRef.current = null;
      }
      return;
    }
    const key = `picked:${res.name}:${res.workspacePath ?? res.stagingId ?? res.name}`;
    if (attachments.some((a) => a.key === key)) {
      closeMenu();
      return;
    }
    setAttachments((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        key,
        name: res.name,
        path: res.path,
        text: res.text,
        truncated: res.truncated,
        kind: "file",
        workspacePath: res.workspacePath,
        stagingId: res.stagingId,
        binary: res.binary,
      },
    ]);
    closeMenu();
    textareaRef.current?.focus();
  }, [
    attachments,
    closeMenu,
    conversationId,
    menuMode,
    setAttachments,
    textareaRef,
  ]);

  const handleMenuNavKey = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!menuMode) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) =>
            Math.min(i + 1, Math.max(flatItems.length - 1, 0)),
          );
          return true;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return true;
        case "Enter":
          if (flatItems[activeIndex]) {
            e.preventDefault();
            selectItem(flatItems[activeIndex]);
            return true;
          }
          return false;
        case "Tab":
          if (flatItems[activeIndex]) {
            e.preventDefault();
            selectItem(flatItems[activeIndex]);
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
    [menuMode, flatItems, activeIndex, selectItem, closeMenu, textareaRef],
  );

  return {
    menuMode,
    sections,
    flatItems,
    /** @deprecated 兼容旧调用；等同 flatItems */
    items: flatItems,
    activeIndex,
    indexLoading,
    menuError,
    query,
    sourceCount,
    indexLoadedRef,
    searchInputRef,
    setQuery,
    setActiveIndex,
    openBrowse,
    syncMention,
    attachEntry,
    selectItem,
    closeMenu,
    handleMenuNavKey,
    handleAddRoot,
    pickLocalFile,
  };
}
