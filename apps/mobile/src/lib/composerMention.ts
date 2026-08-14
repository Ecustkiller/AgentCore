/**
 * Agent 对话 composer @ 引用：分类、过滤、对话摘录、目录清单。
 * 与桌面 MentionMenu 同语义，各端新建（不搬组件）。IM 群聊 @人 不走这里。
 */

export const CONV_MENTION_MSG_LIMIT = 40;
export const CONV_MENTION_CHAR_CAP = 60 * 1024;
export const MAX_AGENT_MENTIONS = 10;
export const EMPTY_MENTION_INDEX_LIMIT = 6;
export const DRILL_MENTION_INDEX_LIMIT = 50;

export type MentionSectionId = "team" | "conversation" | "folder" | "file";
export type MentionCategoryId = "attach" | MentionSectionId;

export interface PendingAgentMention {
  id: string;
  agentId: string;
  role: string;
}

export interface MentionCategoryRow {
  id: MentionCategoryId;
  label: string;
  count: number;
  disabled: boolean;
  hint?: string;
  loading?: boolean;
}

export const MENTION_CATEGORY_LABEL: Record<MentionSectionId, string> = {
  team: "团队",
  conversation: "对话",
  folder: "文件夹",
  file: "文件",
};

const FLAT_CAP = 200;
const TREE_MAX_LINES = 200;
const TREE_MAX_DEPTH = 4;

const INTERNAL_ZONES = ["index", "trash", "baselines", "versions"] as const;

/** Skip AgentCore/{index,trash,baselines,versions} — same zones the file hub hides. */
export function isInternalZonePath(path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!p || p === ".") return false;
  for (const zone of INTERNAL_ZONES) {
    const prefix = `AgentCore/${zone}`;
    if (p === prefix || p.startsWith(`${prefix}/`)) return true;
  }
  return false;
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

export function parseMentionFilter(rawQuery: string): {
  section: MentionSectionId | null;
  filter: string;
} {
  const q = rawQuery.trimStart();
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

export function showMentionCategoryLevel(opts: {
  sectionFilter: MentionSectionId | null;
  activeCategory: MentionSectionId | null;
  filterText: string;
}): boolean {
  return (
    opts.sectionFilter === null &&
    opts.activeCategory === null &&
    !opts.filterText.trim()
  );
}

export function buildMentionCategoryRows(input: {
  counts: Record<MentionSectionId, number>;
  loadingFiles?: boolean;
}): MentionCategoryRow[] {
  const attach: MentionCategoryRow = {
    id: "attach",
    label: "附件",
    count: 0,
    disabled: false,
    hint: "从本机添加",
  };
  const rest: MentionCategoryRow[] = (
    ["team", "conversation", "folder", "file"] as const
  ).map((id) => {
    const count = input.counts[id];
    if (id === "team") {
      return {
        id,
        label: MENTION_CATEGORY_LABEL[id],
        count,
        disabled: count === 0,
        hint: count === 0 ? "多 Agent 回合后可点名" : undefined,
      };
    }
    return {
      id,
      label: MENTION_CATEGORY_LABEL[id],
      count,
      disabled: false,
      loading:
        Boolean(input.loadingFiles) &&
        (id === "folder" || id === "file") &&
        count === 0,
    };
  });
  return [attach, ...rest];
}

export function pickRecentConversations(
  list: ReadonlyArray<{ id: string; title: string | null }>,
  excludeId: string | null,
  filter: string,
  limit = EMPTY_MENTION_INDEX_LIMIT,
): { id: string; title: string }[] {
  const q = filter.trim().toLowerCase();
  let rows = list.filter((c) => c.id !== excludeId);
  if (q) {
    rows = rows.filter((c) => (c.title || "").toLowerCase().includes(q));
  }
  return rows.slice(0, limit).map((c) => ({
    id: c.id,
    title: c.title || "未命名对话",
  }));
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

export function toOutgoingAgentMentions(
  pending: PendingAgentMention[],
): { agent_id: string; role: string }[] {
  return pending.slice(0, MAX_AGENT_MENTIONS).map((a) => ({
    agent_id: a.agentId,
    role: a.role,
  }));
}

export function attachmentDraftKey(a: {
  kind: string;
  path: string;
  name: string;
  conversation_id?: string;
  id?: string;
}): string {
  if (a.id) return a.id;
  return `${a.kind}:${a.conversation_id ?? a.path}:${a.name}`;
}

export function filterByText<T>(
  items: T[],
  filter: string,
  textOf: (item: T) => string,
  limit: number,
): T[] {
  const q = filter.trim().toLowerCase();
  const rows = q
    ? items.filter((item) => textOf(item).toLowerCase().includes(q))
    : items;
  return rows.slice(0, limit);
}

export function deriveDirPaths(filePaths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of filePaths) {
    const segs = path.split("/").filter(Boolean);
    segs.pop();
    let acc = "";
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (seen.has(acc)) continue;
      seen.add(acc);
      out.push(acc);
    }
  }
  return out;
}

export function buildDirListing(
  filePaths: string[],
  dir: { name: string; display: string; prefix: string },
): { text: string; truncated: boolean; fileCount: number } {
  const prefix = dir.prefix ? `${dir.prefix.replace(/\/+$/, "")}/` : "";
  const rels = filePaths
    .filter((p) => (prefix ? p.startsWith(prefix) : true))
    .map((p) => (prefix ? p.slice(prefix.length) : p))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "zh"));
  const fileCount = rels.length;
  const header = `${dir.display}/ (${fileCount} 个文件)`;
  if (fileCount === 0) {
    return { text: header, truncated: false, fileCount: 0 };
  }
  if (fileCount <= FLAT_CAP) {
    return {
      text: `${header}\n${rels.map((r) => `  ${r}`).join("\n")}`,
      truncated: false,
      fileCount,
    };
  }

  interface DirNode {
    name: string;
    total: number;
    direct: number;
    children: Map<string, DirNode>;
  }
  const root: DirNode = {
    name: dir.name,
    total: 0,
    direct: 0,
    children: new Map(),
  };
  for (const rel of rels) {
    const segs = rel.split("/");
    segs.pop();
    root.total++;
    let node = root;
    for (const seg of segs) {
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, total: 0, direct: 0, children: new Map() };
        node.children.set(seg, child);
      }
      child.total++;
      node = child;
    }
    node.direct++;
  }

  const lines: string[] = [];
  let over = false;
  const walk = (node: DirNode, depth: number, indent: string): void => {
    const kids = [...node.children.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "zh"),
    );
    for (const k of kids) {
      if (lines.length >= TREE_MAX_LINES) {
        over = true;
        return;
      }
      lines.push(`${indent}${k.name}/ (${k.total})`);
      if (depth + 1 < TREE_MAX_DEPTH && k.children.size > 0) {
        walk(k, depth + 1, `${indent}  `);
      }
    }
  };
  walk(root, 0, "  ");
  if (root.direct > 0) {
    lines.push(`  （另有 ${root.direct} 个文件直接位于该目录）`);
  }
  if (over) lines.push("  …（更多子目录已省略）");
  return {
    text: `${dir.display}/ (${fileCount} 个文件，目录结构概览；已省略文件名，括号内为各目录递归文件数)\n${lines.join("\n")}`,
    truncated: true,
    fileCount,
  };
}
