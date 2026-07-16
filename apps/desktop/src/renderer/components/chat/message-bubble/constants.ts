import type { ProcessStep, ToolPhase } from "@/types/events";
import {
  ArrowUp,
  BookOpen,
  Brain,
  Code2,
  FileText,
  Folder,
  Globe,
  HelpCircle,
  type LucideIcon,
  PenLine,
  Pencil,
  Search,
  Terminal,
  Trash2,
  Users,
  Wrench,
} from "lucide-react";

/** Icon + English action label for a builtin tool, by its backend name. */
export const TOOL_META: Record<string, { Icon: LucideIcon; label: string }> = {
  web_search: { Icon: Search, label: "Search web" },
  read_url: { Icon: Globe, label: "Read page" },
  grep: { Icon: Code2, label: "Grep code" },
  code_execute: { Icon: Terminal, label: "Run code" },
  file_read: { Icon: FileText, label: "Read file" },
  file_write: { Icon: FileText, label: "Write file" },
  file_append: { Icon: FileText, label: "Append file" },
  file_list: { Icon: Folder, label: "List dir" },
  str_replace: { Icon: Pencil, label: "Edit file" },
  file_delete: { Icon: Trash2, label: "Delete file" },
  file_move: { Icon: FileText, label: "Move file" },
  file_copy: { Icon: FileText, label: "Copy file" },
  mkdir: { Icon: FileText, label: "Make dir" },
  file_batch: { Icon: FileText, label: "Batch files" },
  delegate: { Icon: Users, label: "Delegate" },
  ask_user: { Icon: HelpCircle, label: "Ask you" },
  consult_skill: { Icon: BookOpen, label: "Consult skill" },
  consult_memory: { Icon: Brain, label: "Consult memory" },
  revise: { Icon: PenLine, label: "Revise" },
  escalate: { Icon: ArrowUp, label: "Escalate" },
};

/** Chinese labels for tool-group collapse summaries (描述性/计数类 — stay Chinese). */
const TOOL_SUMMARY_LABEL: Record<string, string> = {
  web_search: "搜索网页",
  read_url: "读取网页",
  grep: "检索代码",
  code_execute: "执行代码",
  file_read: "读取文件",
  file_write: "写入文件",
  file_append: "追加文件",
  file_list: "列出目录",
  str_replace: "编辑文件",
  file_delete: "删除文件",
  file_move: "移动文件",
  file_copy: "复制文件",
  mkdir: "创建目录",
  file_batch: "批量文件操作",
  delegate: "委派任务",
  ask_user: "向你确认",
  consult_skill: "查阅能力",
  consult_memory: "查阅记忆",
  revise: "修订产物",
  escalate: "上报问题",
};

const toolSummaryLabel = (name: string): string =>
  TOOL_SUMMARY_LABEL[name] ?? name;

export const toolMeta = (name: string): { Icon: LucideIcon; label: string } =>
  TOOL_META[name] ?? { Icon: Wrench, label: name };

/** 工具执行阶段进度 → 等待态文案 (联网前端展示优化): a running tool's coarse phase (from a
 * `tool_use_progress` event) as user-facing text — a slow builtin fires these while its blocking
 * leg is in flight so the waiting row is live instead of a dead spinner. web_search: 检索/排队/
 * 备用引擎; read_url: 抓取/提取; code_execute: 执行. */
const TOOL_PHASE_TEXT: Record<ToolPhase, string> = {
  queued: "排队中",
  querying: "正在检索",
  fallback: "改用备用引擎",
  fetching: "正在抓取网页",
  reading: "正在提取正文",
  executing: "正在执行",
  blocked: "出网受限",
};

/** Waiting-state text for a running tool step's `phase`, or null when it has none yet.
 * An unrecognized (newer-backend) phase degrades to a generic「处理中」rather than vanishing. */
export function toolPhaseText(phase: string | undefined): string | null {
  if (!phase) return null;
  return TOOL_PHASE_TEXT[phase as ToolPhase] ?? "处理中";
}

const TOOL_DETAIL_KEYS = [
  "query",
  "url",
  "pattern",
  "path",
  "command",
  "code",
  "q",
  "text",
];

export function toolDetail(args: Record<string, unknown>): string {
  for (const k of TOOL_DETAIL_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export function baseName(detail: string): string {
  if (!detail) return "";
  const segs = detail.split(/[/\\]/);
  return segs[segs.length - 1] || detail;
}

export function toolGroupSummary(
  tools: Extract<ProcessStep, { kind: "tool" }>[],
): string {
  const sameKind = tools.every((t) => t.tool_name === tools[0].tool_name);
  // read_url args are bare URLs — baseName yields opaque article ids. Prefer a
  // count title (matches the merged source-collection header).
  if (sameKind && tools[0]?.tool_name === "read_url") {
    return `读取网页 · ${tools.length} 个来源`;
  }
  if (sameKind && tools.length <= 3) {
    const label = toolSummaryLabel(tools[0].tool_name);
    const names = tools.map((t) => baseName(toolDetail(t.arguments)));
    if (names.every(Boolean)) return `${label} ${names.join(" · ")}`;
  }
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const t of tools) {
    const label = toolSummaryLabel(t.tool_name);
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return order.map((l) => `${l} ${counts.get(l)}`).join(" · ");
}
