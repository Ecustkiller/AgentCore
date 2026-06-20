import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  getConversations,
  patchConversationCache,
  upsertConversationFront,
} from "@/hooks/useConversations";
import {
  type EntryKind,
  type IndexedEntry,
  buildDirListing,
  filterEntries,
  loadFileIndex,
} from "@/lib/fileIndex";
import type { FileSource } from "@/lib/fileSource";
import { api } from "@/services/api";
import { markCloudEscapeConversation } from "@/services/defaultWorkspace";
import { dispatchHandoffJob } from "@/services/handoff";
import { fetchMessageWindow, loadLatestWindow } from "@/services/messages";
import { searchAll } from "@/services/search";
import { createLocalRootSource } from "@/services/sources/localRootSource";
import { createCloudWorkspaceSource } from "@/services/sources/workspaceSource";
import type { OutgoingAttachment } from "@/services/streamConversation";
import { sendTurn } from "@/services/turns";
import { getWorkspaceBinding } from "@/services/workspaceBinding";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks";
import { useComposerDraftStore } from "@/stores/composer";
import {
  getActiveRuntime,
  useActiveGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { useFoldersStore } from "@/stores/folders";
import {
  Cloud,
  CloudUpload,
  Folder,
  MessageSquare,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MentionMenu } from "./MentionMenu";

/** 已选附件（含正文，仅发送时携带；气泡只展示元信息）。 */
interface PendingAttachment {
  id: string;
  /** kind:sourceId:relPath，用于去重。 */
  key: string;
  name: string;
  path: string;
  /** 文件为正文；目录为「文件清单」；对话为最近若干条消息。仅发送时携带，不入库。 */
  text: string;
  truncated: boolean;
  /** file=单文件正文；dir=目录文件清单；conversation=引用对话。 */
  kind: EntryKind;
  /** 仅 kind=conversation：被引用对话的 id。 */
  conversationId?: string;
}

type MenuMode = "mention" | "browse" | null;

// 镜像主进程 fs-service 的 TEXT_PREVIEW_CAP（256KB）：拖入文件在 renderer 直读，
// 故同步同一截断阈值，保证「@ 引用」与「拖入」两条路径行为一致。
const TEXT_PREVIEW_CAP = 256 * 1024;

/**
 * 读取拖入的 OS 文件为文本附件。拖拽本身即用户的显式授权，故绕过「授权根」直读
 * 内容；与主进程 `readFile` 同策略：超 256KB 截断、含 NUL 字节视为二进制、图片
 * 暂不支持（模型无视觉能力）。
 */
async function readDroppedFile(
  file: File,
): Promise<
  { ok: true; text: string; truncated: boolean } | { ok: false; reason: string }
> {
  if (file.type.startsWith("image/")) {
    return { ok: false, reason: "暂不支持图片附件（模型尚无视觉能力）" };
  }
  const head = await file.slice(0, TEXT_PREVIEW_CAP + 1).arrayBuffer();
  const bytes = new Uint8Array(head);
  if (bytes.includes(0)) {
    return { ok: false, reason: "二进制文件无法作为文本附件" };
  }
  const text = new TextDecoder("utf-8").decode(
    bytes.subarray(0, Math.min(bytes.length, TEXT_PREVIEW_CAP)),
  );
  return { ok: true, text, truncated: file.size > TEXT_PREVIEW_CAP };
}

// @对话引用（物化）：拉取窗口的条数上限 + 注入正文的总字符上限。取最近 N 条；整体
// 超过字符上限则保留更靠后（更贴近当前意图）的部分并标记截断。MVP 不做 LLM 摘要。
const CONV_MENTION_MSG_LIMIT = 40;
const CONV_MENTION_CHAR_CAP = 60 * 1024;

/**
 * 把一段对话的消息格式化为可注入的上下文文本（每条 "用户/助手: 正文"）。返回是否因
 * 条数或总长被截断，供 chip 标注。仅取有正文的消息；空对话返回空串。
 */
function formatConversationContext(
  messages: { role: string; content: string }[],
): { text: string; truncated: boolean } {
  const usable = messages.filter((m) => m.content.trim());
  const recent = usable.slice(-CONV_MENTION_MSG_LIMIT);
  let truncated = recent.length < usable.length;
  const body = recent
    .map(
      (m) => `${m.role === "assistant" ? "助手" : "用户"}: ${m.content.trim()}`,
    )
    .join("\n\n");
  let text = body;
  if (text.length > CONV_MENTION_CHAR_CAP) {
    // 超长：从尾部回切，保留更靠后的消息（更贴近用户当前提问）。
    text = text.slice(text.length - CONV_MENTION_CHAR_CAP);
    truncated = true;
  }
  return { text: text.trim(), truncated };
}

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

/**
 * Build the {@link FileSource}s that feed the @ index for the active conversation
 * (文件中枢统一 F4): the conversation's **cloud** workspace (so its server-side
 * files become @-able) plus every authorized local OS root. A *local*-mode
 * workspace needs no extra source — it *is* one of those local roots, already
 * indexed below. A 裸聊 (no folder) has no cloud workspace yet, so it indexes local
 * only until it is promoted into a folder.
 *
 * 文件夹即工作区: the cloud workspace **is** the conversation's folder (`folder:<id>`);
 * a folderless or local chat contributes no cloud source. Failure to resolve the
 * binding degrades gracefully to local-only.
 */
async function buildMentionSources(
  conversationId: string | null,
): Promise<FileSource[]> {
  const sources: FileSource[] = [];

  if (conversationId) {
    try {
      const binding = await getWorkspaceBinding(conversationId);
      if (binding.mode === "cloud") {
        const folderId =
          getConversations().find((c) => c.id === conversationId)?.folderId ??
          null;
        if (folderId) {
          sources.push(
            createCloudWorkspaceSource(`folder:${folderId}`, "工作区"),
          );
        }
      }
    } catch {
      // Binding unknown (e.g. a never-sent draft) — index local roots only.
    }
  }

  const roots = (await window.fsApi?.listRoots()) ?? [];
  for (const r of roots) sources.push(createLocalRootSource(r.id, r.name));
  return sources;
}

export function MessageInput() {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // 拖入文件：dragOver 驱动放置区高亮，dropError 临时提示被拒原因（图片/二进制/文件夹）。
  const [dragOver, setDragOver] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const dropErrorTimer = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isGenerating = useActiveGenerating();
  const addMessage = useConversationStore((s) => s.addMessage);
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const navigate = useNavigate();
  // 后台云端任务（交接「方案 B」）：本地模式对话才显示「后台」开关；开启后发送即把任务
  // 交给云端团队后台跑（dispatchHandoffJob），而非普通发消息。
  const [isLocal, setIsLocal] = useState(false);
  const [backgroundMode, setBackgroundMode] = useState(false);

  // ---- @ 提及 / 文件浏览菜单 ----
  const [menuMode, setMenuMode] = useState<MenuMode>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [fileIndex, setFileIndex] = useState<IndexedEntry[]>([]);
  const [dirIndex, setDirIndex] = useState<IndexedEntry[]>([]);
  const [sourceCount, setSourceCount] = useState(0);
  const [indexLoading, setIndexLoading] = useState(false);
  // @对话候选（搜索驱动，独立于本地文件索引）。
  const [convItems, setConvItems] = useState<IndexedEntry[]>([]);
  const indexLoadedRef = useRef(false);
  // id → source, so attachEntry reads a picked file through its own source
  // (local IPC vs cloud REST) without branching on where the file lives.
  const sourcesRef = useRef<Map<string, FileSource>>(new Map());
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
  const fileItems = useMemo(
    () => filterEntries(entries, query),
    [entries, query],
  );
  // 对话候选（搜索驱动）置顶，其后接本地文件 / 目录候选。
  const items = useMemo(
    () => [...convItems, ...fileItems],
    [convItems, fileItems],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: query/menuMode are intentional re-run keys — reset the highlighted item whenever the query or menu mode changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, menuMode]);

  // @对话候选：对话无法像文件那样预载索引，故按 query 驱动防抖查 /v1/search 的
  // conversation 分组，映射成 IndexedEntry 复用同一菜单。query 空 / 菜单关闭即清空；
  // cancelled + 清 timer 防抖动并丢弃过期请求结果（竞态）。
  useEffect(() => {
    const q = query.trim();
    if (!menuMode || !q) {
      setConvItems([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchAll(q, { types: ["conversation"], limit: 6 })
        .then((res) => {
          if (cancelled) return;
          const section = res.sections.find((s) => s.type === "conversation");
          const candidates = (section?.items ?? []).map<IndexedEntry>((it) => ({
            sourceId: "conversation",
            sourceLabel: "对话",
            relPath: it.id,
            name: it.title || "未命名对话",
            display: it.title || "未命名对话",
            kind: "conversation",
          }));
          setConvItems(candidates);
        })
        .catch(() => {
          if (!cancelled) setConvItems([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
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

  // 回填 from a non-blocking ask card (its option chips drop the user's pick into the
  // draft). Keyed on the store's monotonic token so an identical text still applies;
  // append stacks answers to multiple questions, replace overwrites. Focus so the user
  // can edit / send (a disabled textarea while generating keeps the value, ready to go).
  const draftToken = useComposerDraftStore((s) => s.token);
  // draftToken is the intentional re-run key — apply the latest fill exactly once per bump.
  useEffect(() => {
    if (draftToken === 0) return;
    const { text, mode } = useComposerDraftStore.getState();
    setValue((v) => (mode === "append" && v.trim() ? `${v}\n${text}` : text));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [draftToken]);

  const ensureIndex = useCallback(async () => {
    if (indexLoadedRef.current) return;
    setIndexLoading(true);
    try {
      const sources = await buildMentionSources(conversationId);
      sourcesRef.current = new Map(sources.map((s) => [s.id, s]));
      const { files, dirs, sourceCount } = await loadFileIndex(sources);
      setFileIndex(files);
      setDirIndex(dirs);
      setSourceCount(sourceCount);
      indexLoadedRef.current = true;
    } catch {
      setMenuError("读取文件列表失败");
    } finally {
      setIndexLoading(false);
    }
  }, [conversationId]);

  // Switching conversations changes the @-able cloud workspace — invalidate the
  // cached index so the next mention rebuilds against the new conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is an intentional re-run key — invalidate the index whenever the active conversation changes.
  useEffect(() => {
    indexLoadedRef.current = false;
    setFileIndex([]);
    setDirIndex([]);
    setSourceCount(0);
    sourcesRef.current = new Map();
  }, [conversationId]);

  // Resolve cloud/local for the 「后台云端」 entry (shared via the backgroundTasks
  // store so the timeline feed reuses the same binding lookup). Cloud / drafts hide
  // the entry; leaving local mode also disarms any armed background mode.
  // conversationId is the intentional re-run key — re-resolve the mode whenever the active conversation changes.
  useEffect(() => {
    if (!conversationId) {
      setIsLocal(false);
      setBackgroundMode(false);
      return;
    }
    let cancelled = false;
    void useBackgroundTasksStore
      .getState()
      .ensureMode(conversationId)
      .then((mode) => {
        if (cancelled) return;
        const local = mode === "local";
        setIsLocal(local);
        if (!local) setBackgroundMode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

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
      const key = `${entry.kind}:${entry.sourceId}:${entry.relPath}`;
      if (attachments.some((a) => a.key === key)) {
        closeMenu();
        textareaRef.current?.focus();
        return;
      }

      let next: PendingAttachment | null = null;
      if (entry.kind === "conversation") {
        // 物化：拉该对话最新窗口 → 格式化成「用户/助手: 正文」注入文本。用
        // fetchMessageWindow 取返回值（而非 loadLatestWindow），不污染当前会话 store。
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
          // 还有更早消息未拉入也视为截断。
          truncated: truncated || win.hasMoreBefore,
          kind: "conversation",
          conversationId: entry.relPath,
        };
      } else if (entry.kind === "dir") {
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
        // Read through the entry's own source — local files over IPC, cloud
        // workspace files over REST — without branching on where they live.
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
            res.kind === "image"
              ? "暂不支持图片附件（模型尚无视觉能力）"
              : res.kind === "too-large"
                ? "文件过大，无法作为附件"
                : "二进制文件无法作为文本附件",
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

  const flashDropError = useCallback((msg: string) => {
    setDropError(msg);
    if (dropErrorTimer.current) window.clearTimeout(dropErrorTimer.current);
    dropErrorTimer.current = window.setTimeout(() => setDropError(null), 3000);
  }, []);

  const attachDroppedFile = useCallback(
    async (file: File) => {
      // Dropped files carry no rootId/relPath, so key on name+size to dedupe.
      const key = `dropped:${file.name}:${file.size}`;
      if (attachments.some((a) => a.key === key)) return;
      const res = await readDroppedFile(file);
      if (!res.ok) {
        flashDropError(res.reason);
        return;
      }
      setAttachments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          key,
          name: file.name,
          path: file.name,
          text: res.text,
          truncated: res.truncated,
          kind: "file",
        },
      ]);
    },
    [attachments, flashDropError],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      // Only react to OS file drags — ignore text drags within the textarea.
      if (isGenerating || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragOver(true);
    },
    [isGenerating],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Leaving into a descendant still counts as inside — only clear on true exit.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragOver(false);
      if (isGenerating) return;
      // Prefer the items API so directories can be detected (and skipped — dirs
      // go through the @ browser, which attaches a file listing); fall back to
      // the flat file list when items is unavailable.
      const dropped: File[] = [];
      let sawDir = false;
      const items = Array.from(e.dataTransfer.items ?? []);
      if (items.length) {
        for (const item of items) {
          if (item.kind !== "file") continue;
          if (item.webkitGetAsEntry?.()?.isDirectory) {
            sawDir = true;
            continue;
          }
          const f = item.getAsFile();
          if (f) dropped.push(f);
        }
      } else {
        dropped.push(...Array.from(e.dataTransfer.files));
      }
      for (const f of dropped) await attachDroppedFile(f);
      if (sawDir) flashDropError("文件夹请用 @ 引用，拖拽仅支持文件");
    },
    [isGenerating, attachDroppedFile, flashDropError],
  );

  const handleAddRoot = useCallback(async () => {
    const root = await window.fsApi.addRoot();
    if (!root) return;
    indexLoadedRef.current = false;
    await ensureIndex();
  }, [ensureIndex]);

  const stopGeneration = useCallback(() => {
    useConversationStore.getState().stopGeneration();
  }, []);

  // 把一条任务派发为后台云端任务（交接「方案 B」/ P2e e2）：先乐观落一张「派发中」卡进
  // 时间线，再经 dispatchHandoffJob 走 e1 打包 + 起云端作业；成功后拉权威列表换掉乐观项，
  // 失败则把这张卡就地标红——全程不阻塞输入框（用户可继续聊）。
  const dispatchBackgroundTask = useCallback((convId: string, task: string) => {
    const store = useBackgroundTasksStore.getState();
    const tempId = crypto.randomUUID();
    const now = new Date().toISOString();
    const base = {
      id: tempId,
      sourceConversationId: convId,
      jobConversationId: "",
      baseSnapshotId: "",
      resultSnapshotId: null as string | null,
      task,
      createdAt: now,
      finishedAt: null as string | null,
    };
    store.upsert(convId, {
      ...base,
      status: "pending",
      error: null,
      updatedAt: now,
    });
    void dispatchHandoffJob(convId, task)
      .then(() => store.load(convId))
      .catch((err) => {
        store.upsert(convId, {
          ...base,
          status: "failed",
          error: err instanceof Error ? err.message : "派发失败",
          updatedAt: new Date().toISOString(),
        });
      });
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || isGenerating) return;

    // 后台云端任务分支：本地模式 + 开关开启时，交给云端团队后台跑，不走普通发送。
    // 开关只在已落库的本地对话出现，故此处必有 conversationId。
    const activeConvId = useConversationStore.getState().currentConversationId;
    if (backgroundMode && isLocal && activeConvId) {
      dispatchBackgroundTask(activeConvId, trimmed);
      setValue("");
      closeMenu();
      return;
    }

    const pending = attachments;
    const store = useConversationStore.getState();
    const isFirstMessage = getActiveRuntime().messages.length === 0;

    let conversationId = store.currentConversationId;
    let createdNew = false;
    if (!conversationId) {
      // A draft started from a folder header is born *in* that folder (folder_id
      // at creation), so it shares the folder's workspace from its first turn.
      // Filing at creation — rather than a follow-up move — avoids racing the
      // workspace-lock guard, which rejects a move once a chat has any messages
      // (双模式工作区 §九 ⑩).
      // 桌面 local-first（决策 #11 / 工作区对称化 D1a）：未显式归档时，这是一条**裸聊**——
      // 不预塞文件夹（folder_id=null），首次产文件时由服务端在默认本地容器下懒建 per 对话
      // 文件夹（信号由 sendTurn 经 `pendingLocalContainerRoot` 携带）。「云端临时对话」逃生口
      // 同为裸聊，但标记后其懒建落云端（不携带容器根）。
      const foldersStore = useFoldersStore.getState();
      const targetFolderId = foldersStore.pendingNewChatFolderId;
      const cloudEscape = foldersStore.pendingNewChatCloud;
      try {
        const conv = await api.post<{ id: string }>("/v1/conversations", {
          title: null,
          folder_id: targetFolderId,
        });
        conversationId = conv.id;
        // 记下逃生口意图，使后续回合的 `pendingLocalContainerRoot` 不为这条裸聊携带容器根
        // （懒建落云端）。仅本进程内有效——逃生口是一次性的随手云问答。
        if (cloudEscape) markCloudEscapeConversation(conv.id);
        upsertConversationFront({
          id: conv.id,
          title: "新对话",
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          lastMessagePreview: null,
          folderId: targetFolderId,
        });
        useConversationStore.getState().setCurrentConversation(conv.id);
        createdNew = true;
        // 消费后复位（folder=null + cloud=false ⇒ 下次草稿仍是桌面默认本地裸聊）。
        useFoldersStore.getState().setPendingNewChatFolder(null);
        useFoldersStore.getState().setPendingNewChatCloud(false);
      } catch {
        return;
      }
    }

    // Reading history (a search-hit jump left newer messages unloaded)? Snap back
    // to the live head before appending, so the turn lands at the true tail rather
    // than into a mid-conversation gap (live-head invariant, 载入模型 B).
    if (!isFirstMessage && getActiveRuntime().hasMoreAfter) {
      try {
        await loadLatestWindow(conversationId);
      } catch {
        /* best-effort: fall through and append at the current tail */
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
            conversationId: a.conversationId,
          }))
        : undefined,
    });
    setValue("");
    setAttachments([]);
    closeMenu();

    if (isFirstMessage) {
      const title = trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed;
      patchConversationCache(conversationId, { title });
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
      conversation_id: a.conversationId,
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
    navigate,
    closeMenu,
    backgroundMode,
    isLocal,
    dispatchBackgroundTask,
  ]);

  useEffect(() => {
    return () => {
      getActiveRuntime().abort?.abort();
      if (dropErrorTimer.current) window.clearTimeout(dropErrorTimer.current);
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
      <div
        className={`relative rounded-xl border bg-card shadow-sm transition-colors ${
          dragOver ? "border-primary ring-2 ring-primary/40" : "border-border"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-card/80 text-sm font-medium text-primary">
            拖放文件以添加为附件
          </div>
        )}
        {dropError && (
          <div className="px-3 pt-2 text-xs text-destructive">{dropError}</div>
        )}
        {menuOpen && (
          <MentionMenu
            items={items}
            activeIndex={activeIndex}
            loading={indexLoading}
            error={menuError}
            query={query}
            showSearch={menuMode === "browse"}
            noRoots={indexLoadedRef.current && sourceCount === 0}
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
                className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg bg-accent px-2 py-1 text-xs text-accent-foreground"
              >
                {a.kind === "dir" ? (
                  <Folder size={12} className="shrink-0" />
                ) : a.kind === "conversation" ? (
                  <MessageSquare size={12} className="shrink-0" />
                ) : (
                  <Paperclip size={12} className="shrink-0" />
                )}
                <SimpleTooltip
                  label={a.kind === "conversation" ? "引用对话" : a.path}
                >
                  <span className="truncate">
                    {a.name}
                    {a.kind === "dir" ? "/" : ""}
                  </span>
                </SimpleTooltip>
                {a.truncated && (
                  <span className="shrink-0 text-muted-foreground">
                    {a.kind === "dir"
                      ? "部分"
                      : a.kind === "conversation"
                        ? "近期"
                        : "已截断"}
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
          placeholder={
            backgroundMode
              ? "描述要交给云端团队后台完成的任务…"
              : "输入消息，@ 引用文件…"
          }
          disabled={isGenerating}
          className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
          rows={1}
        />
        <div className="flex items-center justify-between px-4 pb-3">
          <div className="flex items-center gap-1">
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
            {isLocal && (
              <SimpleTooltip
                label={
                  backgroundMode
                    ? "已切到「后台云端」：发送会把任务交给云端团队后台跑"
                    : "切到「后台云端」：把任务交给云端团队后台跑，结果回来再应用"
                }
              >
                <button
                  type="button"
                  onClick={() => setBackgroundMode((v) => !v)}
                  disabled={isGenerating}
                  aria-label="切换后台云端任务"
                  aria-pressed={backgroundMode}
                  className={`flex size-8 items-center justify-center rounded-lg hover:bg-accent disabled:opacity-40 ${
                    backgroundMode
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground"
                  }`}
                >
                  <Cloud size={16} />
                </button>
              </SimpleTooltip>
            )}
          </div>
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
                aria-label={backgroundMode ? "派发到云端后台" : "发送"}
                className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              >
                {backgroundMode ? (
                  <CloudUpload size={14} />
                ) : (
                  <Send size={14} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
