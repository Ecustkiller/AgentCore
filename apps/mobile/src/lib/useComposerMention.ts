/**
 * Agent 对话 composer @ 分类 sheet 的状态与选中进草稿。
 * 文件/文件夹只走云端已有 list（listWorkspaceFiles / listCloudFolders 等），不造本机索引。
 */

import { getMessages, listConversations } from "@/api/conversations";
import { listCloudFolders } from "@/api/folders";
import {
  type WorkspaceFileEntry,
  downloadWorkspaceFile,
  listWorkspaceFiles,
} from "@/api/workspace";
import {
  downloadWorkspaceFileByWs,
  listWorkspaceFilesByWs,
} from "@/api/workspaces";
import { type MessageAttachment, prepareAttachment } from "@/lib/attachments";
import { folderWorkspaceId } from "@/lib/cloudFolder";
import {
  DRILL_MENTION_INDEX_LIMIT,
  EMPTY_MENTION_INDEX_LIMIT,
  MAX_AGENT_MENTIONS,
  MENTION_CATEGORY_LABEL,
  type MentionSectionId,
  type PendingAgentMention,
  buildDirListing,
  buildMentionCategoryRows,
  deriveDirPaths,
  detectMention,
  filterByText,
  formatConversationContext,
  isInternalZonePath,
  parseMentionFilter,
  pickRecentConversations,
  showMentionCategoryLevel,
} from "@/lib/composerMention";
import { fold } from "@/protocol/fold";
import type { SSEEvent } from "@agentcore/contract-types";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type MentionListItem =
  | { kind: "agent"; agentId: string; role: string; label: string }
  | { kind: "conversation"; id: string; title: string; label: string }
  | {
      kind: "folder";
      source: "cloud" | "dir";
      id: string;
      name: string;
      label: string;
      subtitle?: string;
      wsId?: string;
      path?: string;
    }
  | {
      kind: "file";
      desk: "conv" | "ws";
      deskId: string;
      path: string;
      name: string;
      label: string;
      subtitle?: string;
    };

type FileDesk = { kind: "conv" | "ws"; id: string; label: string };

type IndexedFile = {
  desk: "conv" | "ws";
  deskId: string;
  deskLabel: string;
  path: string;
  name: string;
};

export function pickTeamAgents(
  history: ReadonlyArray<{
    role: string;
    runs?: { events?: SSEEvent[] } | null;
  }>,
  liveTurns: ReadonlyArray<{ events: SSEEvent[] }>,
): { id: string; role: string }[] {
  for (let i = liveTurns.length - 1; i >= 0; i--) {
    const events = liveTurns[i]?.events;
    if (!events?.length) continue;
    try {
      const agents = fold(events).agents;
      if (agents.length > 0) {
        return agents.map((a) => ({ id: a.id, role: a.role }));
      }
    } catch {
      /* skip a turn we cannot fold */
    }
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "assistant") continue;
    const events = m.runs?.events;
    if (!events?.length) continue;
    try {
      const agents = fold(events).agents;
      if (agents.length > 0) {
        return agents.map((a) => ({ id: a.id, role: a.role }));
      }
    } catch {
      /* skip a turn we cannot fold */
    }
  }
  return [];
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function listingFiles(entries: WorkspaceFileEntry[]): string[] {
  return entries
    .filter((e) => !e.is_dir && !isInternalZonePath(e.path))
    .map((e) => e.path);
}

export function useComposerMention({
  conversationId,
  input,
  setInput,
  attachments,
  setAttachments,
  agentMentions,
  setAgentMentions,
  history,
  turns,
  textareaRef,
  onPickAttach,
  onError,
}: {
  conversationId: string | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  attachments: MessageAttachment[];
  setAttachments: Dispatch<SetStateAction<MessageAttachment[]>>;
  agentMentions: PendingAgentMention[];
  setAgentMentions: Dispatch<SetStateAction<PendingAgentMention[]>>;
  history: ReadonlyArray<{
    role: string;
    runs?: { events?: SSEEvent[] } | null;
  }>;
  turns: ReadonlyArray<{ events: SSEEvent[] }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onPickAttach: () => void;
  onError: (reason: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"mention" | "browse" | null>(null);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<MentionSectionId | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [indexLoading, setIndexLoading] = useState(false);
  const [conversations, setConversations] = useState<
    { id: string; title: string | null }[]
  >([]);
  const [cloudFolders, setCloudFolders] = useState<
    { id: string; name: string }[]
  >([]);
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const mentionRangeRef = useRef<{ start: number; end: number } | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const loadedRef = useRef(false);

  const teamAgents = useMemo(
    () => pickTeamAgents(history, turns),
    [history, turns],
  );

  const { section: sectionFilter, filter: filterText } = useMemo(
    () => parseMentionFilter(query),
    [query],
  );
  const showCategoryLevel = showMentionCategoryLevel({
    sectionFilter,
    activeCategory,
    filterText,
  });
  const focusedSection = sectionFilter ?? activeCategory;
  const itemLimit = focusedSection
    ? DRILL_MENTION_INDEX_LIMIT
    : EMPTY_MENTION_INDEX_LIMIT;

  const loadIndex = useCallback(async () => {
    if (loadedRef.current) return;
    setIndexLoading(true);
    setError(null);
    try {
      const [convs, folders] = await Promise.all([
        listConversations(false),
        listCloudFolders(),
      ]);
      setConversations(convs.map((c) => ({ id: c.id, title: c.title })));
      setCloudFolders(folders.map((f) => ({ id: f.id, name: f.name })));

      const desks: FileDesk[] = [];
      if (conversationId) {
        desks.push({ kind: "conv", id: conversationId, label: "本对话" });
      }
      for (const f of folders) {
        desks.push({
          kind: "ws",
          id: folderWorkspaceId(f.id),
          label: f.name,
        });
      }
      const listings = await Promise.all(
        desks.map(async (desk) => {
          try {
            const listing =
              desk.kind === "conv"
                ? await listWorkspaceFiles(desk.id)
                : await listWorkspaceFilesByWs(desk.id);
            return { desk, paths: listingFiles(listing.entries) };
          } catch {
            return { desk, paths: [] as string[] };
          }
        }),
      );
      const next: IndexedFile[] = [];
      const seen = new Set<string>();
      for (const { desk, paths } of listings) {
        for (const path of paths) {
          const key = `${desk.kind}:${desk.id}:${path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          next.push({
            desk: desk.kind,
            deskId: desk.id,
            deskLabel: desk.label,
            path,
            name: basename(path),
          });
        }
      }
      setFiles(next);
      loadedRef.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载引用列表失败");
    } finally {
      setIndexLoading(false);
    }
  }, [conversationId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is an intentional re-run key
  useEffect(() => {
    loadedRef.current = false;
    setFiles([]);
    setCloudFolders([]);
    setConversations([]);
  }, [conversationId]);

  const close = useCallback(() => {
    setOpen(false);
    setMode(null);
    setError(null);
    setActiveCategory(null);
    mentionRangeRef.current = null;
  }, []);

  const openMention = useCallback(
    (start: number, end: number, q: string) => {
      mentionRangeRef.current = { start, end };
      setQuery(q);
      if (mode !== "mention") setActiveCategory(null);
      setMode("mention");
      setOpen(true);
      setError(null);
      void loadIndex();
    },
    [loadIndex, mode],
  );

  const openBrowse = useCallback(() => {
    mentionRangeRef.current = null;
    setQuery("");
    setActiveCategory(null);
    setMode("browse");
    setOpen(true);
    setError(null);
    void loadIndex();
  }, [loadIndex]);

  const syncMention = useCallback(
    (text: string, caret?: number) => {
      const pos = caret ?? text.length;
      const m = detectMention(text, pos);
      if (m) {
        openMention(m.start, pos, m.query);
      } else if (mode === "mention") {
        close();
      }
    },
    [mode, openMention, close],
  );

  const stripMentionQuery = useCallback(() => {
    const range = mentionRangeRef.current;
    if (mode === "mention" && range) {
      const el = textareaRef.current;
      const latest = el?.value ?? inputRef.current;
      const caret =
        typeof el?.selectionStart === "number" ? el.selectionStart : range.end;
      const detected = detectMention(latest, caret);
      const start = detected?.start ?? range.start;
      const end = detected ? caret : range.end;
      const updated = latest.slice(0, start) + latest.slice(end);
      setInput(updated);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.selectionStart = ta.selectionEnd = start;
        }
      });
    } else {
      textareaRef.current?.focus();
    }
  }, [mode, setInput, textareaRef]);

  const convItems = useMemo(
    () =>
      pickRecentConversations(
        conversations,
        conversationId,
        filterText,
        focusedSection === "conversation"
          ? DRILL_MENTION_INDEX_LIMIT
          : itemLimit,
      ),
    [conversations, conversationId, filterText, focusedSection, itemLimit],
  );

  const allFolderItems = useMemo(() => {
    const cloud = filterByText(
      cloudFolders,
      filterText,
      (f) => f.name,
      Number.MAX_SAFE_INTEGER,
    ).map((f) => ({
      kind: "folder" as const,
      source: "cloud" as const,
      id: f.id,
      name: f.name,
      label: f.name,
      subtitle: "云文件夹",
      wsId: folderWorkspaceId(f.id),
    }));
    const dirItems = (() => {
      const byDesk = new Map<string, IndexedFile[]>();
      for (const f of files) {
        const list = byDesk.get(f.deskId) ?? [];
        list.push(f);
        byDesk.set(f.deskId, list);
      }
      const out: Extract<MentionListItem, { kind: "folder" }>[] = [];
      const seen = new Set<string>();
      for (const [deskId, deskFiles] of byDesk) {
        const label = deskFiles[0]?.deskLabel ?? deskId;
        for (const path of deriveDirPaths(deskFiles.map((f) => f.path))) {
          const key = `${deskId}:${path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            kind: "folder",
            source: "dir",
            id: key,
            name: basename(path),
            label: basename(path),
            subtitle: `${label}/${path}`,
            wsId: deskId,
            path,
          });
        }
      }
      return filterByText(
        out,
        filterText,
        (d) => `${d.label} ${d.subtitle ?? ""}`,
        Number.MAX_SAFE_INTEGER,
      );
    })();
    return [...cloud, ...dirItems];
  }, [cloudFolders, files, filterText]);

  const folderItems = useMemo(() => {
    const cap =
      focusedSection === "folder" ? DRILL_MENTION_INDEX_LIMIT : itemLimit;
    return allFolderItems.slice(0, cap);
  }, [allFolderItems, focusedSection, itemLimit]);

  const fileItems = useMemo(() => {
    const rows: Extract<MentionListItem, { kind: "file" }>[] = files.map(
      (f) => ({
        kind: "file" as const,
        desk: f.desk,
        deskId: f.deskId,
        path: f.path,
        name: f.name,
        label: f.name,
        subtitle: `${f.deskLabel}/${f.path}`,
      }),
    );
    return filterByText(
      rows,
      filterText,
      (f) => `${f.label} ${f.subtitle ?? ""}`,
      focusedSection === "file" ? DRILL_MENTION_INDEX_LIMIT : itemLimit,
    );
  }, [files, filterText, focusedSection, itemLimit]);

  const agentItems = useMemo(() => {
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
      label: a.role,
    }));
  }, [teamAgents, filterText]);

  const categories = useMemo(
    () =>
      buildMentionCategoryRows({
        counts: {
          team: teamAgents.length,
          conversation: pickRecentConversations(
            conversations,
            conversationId,
            filterText,
            Number.MAX_SAFE_INTEGER,
          ).length,
          folder: allFolderItems.length,
          file: filterByText(
            files,
            filterText,
            (f) => `${f.name} ${f.path}`,
            Number.MAX_SAFE_INTEGER,
          ).length,
        },
        loadingFiles: indexLoading,
      }),
    [
      teamAgents.length,
      conversations,
      conversationId,
      filterText,
      allFolderItems.length,
      files,
      indexLoading,
    ],
  );

  const items = useMemo((): MentionListItem[] => {
    if (showCategoryLevel) return [];
    const show = (id: MentionSectionId) =>
      focusedSection === null || focusedSection === id;
    const out: MentionListItem[] = [];
    if (show("team")) out.push(...agentItems);
    if (show("conversation")) {
      out.push(
        ...convItems.map((c) => ({
          kind: "conversation" as const,
          id: c.id,
          title: c.title,
          label: c.title,
        })),
      );
    }
    if (show("folder")) out.push(...folderItems);
    if (show("file")) out.push(...fileItems);
    return out;
  }, [
    showCategoryLevel,
    focusedSection,
    agentItems,
    convItems,
    folderItems,
    fileItems,
  ]);

  const emptyHint = useMemo(() => {
    if (showCategoryLevel) return undefined;
    if (focusedSection === "team" && agentItems.length === 0) {
      return "多 Agent 回合后可点名";
    }
    if (focusedSection === "conversation" && convItems.length === 0) {
      return "暂无其他对话";
    }
    if (focusedSection === "folder" && folderItems.length === 0) {
      return "没有可引用的文件夹";
    }
    if (focusedSection === "file" && fileItems.length === 0) {
      return "没有可引用的文件";
    }
    if (!focusedSection && items.length === 0) return "没有匹配的引用";
    return undefined;
  }, [
    showCategoryLevel,
    focusedSection,
    agentItems.length,
    convItems.length,
    folderItems.length,
    fileItems.length,
    items.length,
  ]);

  const addAttachment = useCallback(
    (next: MessageAttachment) => {
      const key = `${next.kind}:${next.conversation_id ?? next.path}:${next.name}`;
      if (
        attachments.some(
          (a) => `${a.kind}:${a.conversation_id ?? a.path}:${a.name}` === key,
        )
      ) {
        stripMentionQuery();
        close();
        return;
      }
      setAttachments((prev) => [...prev, next]);
      onError(null);
      stripMentionQuery();
      close();
    },
    [attachments, setAttachments, stripMentionQuery, close, onError],
  );

  const selectAgent = useCallback(
    (agentId: string, role: string) => {
      if (agentMentions.some((a) => a.agentId === agentId)) {
        stripMentionQuery();
        close();
        return;
      }
      if (agentMentions.length >= MAX_AGENT_MENTIONS) {
        setError(`最多点名 ${MAX_AGENT_MENTIONS} 个角色`);
        return;
      }
      setAgentMentions((prev) => [
        ...prev,
        { id: crypto.randomUUID(), agentId, role },
      ]);
      onError(null);
      stripMentionQuery();
      close();
    },
    [agentMentions, setAgentMentions, stripMentionQuery, close, onError],
  );

  const selectConversation = useCallback(
    async (id: string, title: string) => {
      let win: Awaited<ReturnType<typeof getMessages>>;
      try {
        win = await getMessages(id);
      } catch {
        setError("读取对话失败");
        return;
      }
      const { text, truncated } = formatConversationContext(
        win.messages.map((m) => ({
          role: m.role,
          content: m.content ?? "",
        })),
      );
      if (!text) {
        setError("该对话暂无可引用的内容");
        return;
      }
      addAttachment({
        id: crypto.randomUUID(),
        name: title,
        path: "对话",
        text,
        truncated: truncated || win.hasMoreBefore,
        kind: "conversation",
        conversation_id: id,
      });
    },
    [addAttachment],
  );

  const selectFolder = useCallback(
    async (item: Extract<MentionListItem, { kind: "folder" }>) => {
      let paths: string[] = [];
      try {
        if (item.source === "cloud" && item.wsId) {
          const listing = await listWorkspaceFilesByWs(item.wsId);
          paths = listingFiles(listing.entries);
        } else if (item.path && item.wsId) {
          const prefix = `${item.path}/`;
          paths = files
            .filter((f) => f.deskId === item.wsId && f.path.startsWith(prefix))
            .map((f) => f.path);
          if (paths.length === 0) {
            const listing = item.wsId.startsWith("folder:")
              ? await listWorkspaceFilesByWs(item.wsId)
              : conversationId
                ? await listWorkspaceFiles(conversationId)
                : { entries: [] };
            paths = listingFiles(listing.entries).filter((p) =>
              p.startsWith(prefix),
            );
          }
        }
      } catch {
        setError("读取文件夹失败");
        return;
      }
      const listing = buildDirListing(paths, {
        name: item.name,
        display: item.subtitle ?? item.name,
        prefix: item.path ?? "",
      });
      if (listing.fileCount === 0) {
        setError("该目录内没有可索引的文件");
        return;
      }
      addAttachment({
        id: crypto.randomUUID(),
        name: item.name,
        path: item.subtitle ?? item.name,
        text: listing.text,
        truncated: listing.truncated,
        kind: "dir",
      });
    },
    [addAttachment, files, conversationId],
  );

  const selectFile = useCallback(
    async (item: Extract<MentionListItem, { kind: "file" }>) => {
      try {
        const downloaded =
          item.desk === "conv"
            ? await downloadWorkspaceFile(item.deskId, item.path)
            : await downloadWorkspaceFileByWs(item.deskId, item.path);
        const file = new File([downloaded.blob], downloaded.filename, {
          type: downloaded.contentType || downloaded.blob.type,
        });
        const res = await prepareAttachment(file, conversationId);
        if (!res.ok) {
          setError(res.reason);
          return;
        }
        addAttachment({
          ...res.attachment,
          id: crypto.randomUUID(),
          path: item.path,
          name: item.name,
        });
      } catch {
        setError("读取文件失败");
      }
    },
    [addAttachment, conversationId],
  );

  const selectItem = useCallback(
    (item: MentionListItem) => {
      if (item.kind === "agent") {
        selectAgent(item.agentId, item.role);
        return;
      }
      if (item.kind === "conversation") {
        void selectConversation(item.id, item.title);
        return;
      }
      if (item.kind === "folder") {
        void selectFolder(item);
        return;
      }
      void selectFile(item);
    },
    [selectAgent, selectConversation, selectFolder, selectFile],
  );

  const pickAttach = useCallback(() => {
    stripMentionQuery();
    close();
    onPickAttach();
  }, [stripMentionQuery, close, onPickAttach]);

  const drill = useCallback((id: MentionSectionId) => {
    setActiveCategory(id);
    setError(null);
  }, []);

  const back = useCallback(() => {
    setActiveCategory(null);
    setError(null);
    if (mode === "browse") setQuery("");
  }, [mode]);

  const canGoBack = Boolean(activeCategory) && !sectionFilter;

  return {
    open,
    mode,
    query,
    setQuery,
    showCategoryLevel,
    categories,
    items,
    emptyHint,
    focusedSection,
    focusedLabel: focusedSection
      ? MENTION_CATEGORY_LABEL[focusedSection]
      : undefined,
    canGoBack,
    loading: indexLoading,
    error,
    openBrowse,
    syncMention,
    close,
    drill,
    back,
    selectItem,
    pickAttach,
  };
}
