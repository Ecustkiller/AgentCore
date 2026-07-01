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

/** Icon + 中文标签 for a builtin tool, by its backend name. */
export const TOOL_META: Record<string, { Icon: LucideIcon; label: string }> = {
  web_search: { Icon: Search, label: "搜索网页" },
  read_url: { Icon: Globe, label: "读取网页" },
  grep: { Icon: Code2, label: "检索代码" },
  code_execute: { Icon: Terminal, label: "执行代码" },
  file_read: { Icon: FileText, label: "读取文件" },
  file_write: { Icon: FileText, label: "写入文件" },
  file_list: { Icon: Folder, label: "列出目录" },
  str_replace: { Icon: Pencil, label: "编辑文件" },
  file_delete: { Icon: Trash2, label: "删除文件" },
  file_move: { Icon: FileText, label: "移动文件" },
  delegate: { Icon: Users, label: "委派任务" },
  ask_user: { Icon: HelpCircle, label: "向你确认" },
  consult_skill: { Icon: BookOpen, label: "查阅能力" },
  consult_memory: { Icon: Brain, label: "查阅记忆" },
  revise: { Icon: PenLine, label: "修订产物" },
  escalate: { Icon: ArrowUp, label: "上报问题" },
};

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
  if (sameKind && tools.length <= 3) {
    const { label } = toolMeta(tools[0].tool_name);
    const names = tools.map((t) => baseName(toolDetail(t.arguments)));
    if (names.every(Boolean)) return `${label} ${names.join(" · ")}`;
  }
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const t of tools) {
    const { label } = toolMeta(t.tool_name);
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return order.map((l) => `${l} ${counts.get(l)}`).join(" · ");
}
