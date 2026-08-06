import type { EntryKind, IndexedEntry } from "@/lib/fileIndex";
import type { FileSource } from "@/lib/fileSource";
import { createLocalRootSource } from "@/services/sources/localRootSource";
import { createCloudWorkspaceSource } from "@/services/sources/workspaceSource";
import { getWorkspaceBinding } from "@/services/workspaceBinding";

/** 已选附件（含正文，仅发送时携带；气泡只展示元信息）。 */
export interface PendingAttachment {
  id: string;
  /** kind:sourceId:relPath，用于去重。 */
  key: string;
  name: string;
  /** 展示路径：优先工作区相对 ``attachments/…``，绝不含 OS 绝对路径。 */
  path: string;
  text: string;
  truncated: boolean;
  kind: EntryKind;
  /** 仅 kind=conversation：被引用对话的 id。 */
  conversationId?: string;
  /** 引用即驻留：已写入对话工作区时的相对路径。 */
  workspacePath?: string;
  /** 主进程暂存 id（草稿 / 待云端上传）；发送前 finalize / consume。 */
  stagingId?: string;
  /** 二进制驻留：无 UTF-8 正文内联。 */
  binary?: boolean;
  /**
   * 浏览器草稿：尚无 conversationId 时暂存 File，建会话后由
   * ``ensureAttachmentResident`` PUT 到云工作区 ``attachments/``。
   * 不可进 localStorage；仅内存。
   */
  fileBlob?: File;
}

/**
 * Pending `@Agent` chip（旁路 attachments，不上 MessageAttachment.kind）。
 * 发送时进 POST ``agent_mentions: [{ agent_id, role }]``。
 */
export interface PendingAgentMention {
  id: string;
  agentId: string;
  role: string;
}

export type MentionSectionId = "team" | "conversation" | "folder" | "file";

export const TEXT_PREVIEW_CAP = 256 * 1024;

export const CONV_MENTION_MSG_LIMIT = 40;
export const CONV_MENTION_CHAR_CAP = 60 * 1024;
/** `@Agent` 点名上限（与发送体 max 对齐）。 */
export const MAX_AGENT_MENTIONS = 10;
/** 空 `@` 时各索引分区默认条数。 */
export const EMPTY_MENTION_INDEX_LIMIT = 6;

export async function readDroppedFile(
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
    return {
      ok: false,
      reason: "二进制文件请在桌面端附加（将驻留到工作区）",
    };
  }
  const text = new TextDecoder("utf-8").decode(
    bytes.subarray(0, Math.min(bytes.length, TEXT_PREVIEW_CAP)),
  );
  return { ok: true, text, truncated: file.size > TEXT_PREVIEW_CAP };
}

export function formatConversationContext(
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
    text = text.slice(text.length - CONV_MENTION_CHAR_CAP);
    truncated = true;
  }
  return { text: text.trim(), truncated };
}

export function detectMention(
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
 * `@` 类型前缀：以「团队/对话/文件/文件夹」或英文 agent/file/dir/folder/conv 开头时
 * 只保留对应分区；前缀后的剩余串作过滤词。
 */
export function parseMentionFilter(rawQuery: string): {
  section: MentionSectionId | null;
  filter: string;
} {
  const q = rawQuery.trimStart();
  // 较长中文前缀优先；英文忽略大小写。
  const rules: { re: RegExp; section: MentionSectionId }[] = [
    { re: /^(文件夹|folder|dir)\s*/i, section: "folder" },
    { re: /^(文件|file)\s*/i, section: "file" },
    { re: /^(对话|conv(?:ersation)?)\s*/i, section: "conversation" },
    { re: /^(团队|agent)\s*/i, section: "team" },
  ];
  for (const { re, section } of rules) {
    const m = q.match(re);
    if (m) return { section, filter: q.slice(m[0].length) };
  }
  return { section: null, filter: q };
}

/** 近期对话 → IndexedEntry；排除当前会话，可选标题子串过滤。 */
export function pickRecentConversations(
  list: ReadonlyArray<{ id: string; title: string }>,
  excludeId: string | null,
  filter: string,
  limit = EMPTY_MENTION_INDEX_LIMIT,
): IndexedEntry[] {
  const q = filter.trim().toLowerCase();
  let rows = list.filter((c) => c.id !== excludeId);
  if (q) {
    rows = rows.filter((c) => (c.title || "").toLowerCase().includes(q));
  }
  return rows.slice(0, limit).map((c) => ({
    sourceId: "conversation",
    sourceLabel: "对话",
    relPath: c.id,
    name: c.title || "未命名对话",
    display: c.title || "未命名对话",
    kind: "conversation" as const,
  }));
}

export async function buildMentionSources(
  conversationId: string | null,
): Promise<FileSource[]> {
  const sources: FileSource[] = [];

  if (conversationId) {
    try {
      const binding = await getWorkspaceBinding(conversationId);
      if (binding.mode === "cloud") {
        sources.push(
          createCloudWorkspaceSource(`conv:${conversationId}`, "工作区"),
        );
      }
    } catch {
      // Binding unknown — index local roots only.
    }
  }

  const roots = (await window.fsApi?.listRoots()) ?? [];
  for (const r of roots) sources.push(createLocalRootSource(r.id, r.name));
  return sources;
}
