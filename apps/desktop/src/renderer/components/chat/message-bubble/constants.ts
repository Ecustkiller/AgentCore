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
  Scale,
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
  // CEO 编排原语（组队辩论）：气泡侧只在「Composing …」参数组装心跳时露出，
  // 图标与开工卡的 debate 形态一致（Scale）。
  debate: { Icon: Scale, label: "Debate" },
  ask_user: { Icon: HelpCircle, label: "Ask you" },
  consult_skill: { Icon: BookOpen, label: "Consult skill" },
  consult_memory: { Icon: Brain, label: "Consult memory" },
  revise: { Icon: PenLine, label: "Revise" },
  escalate: { Icon: ArrowUp, label: "Escalate" },
};

/** Tool-group collapse summaries reuse {@link TOOL_META} English labels (same chrome as ToolLine). */
const toolSummaryLabel = (name: string): string =>
  TOOL_META[name]?.label ?? name;

export const toolMeta = (name: string): { Icon: LucideIcon; label: string } =>
  TOOL_META[name] ?? { Icon: Wrench, label: name };

/** Tool execution phase → waiting-state chrome (network UX): a running tool's coarse phase
 * (from a `tool_use_progress` event) as user-facing text — a slow builtin fires these while its
 * blocking leg is in flight so the waiting row is live instead of a dead spinner. web_search:
 * Searching / Queued / Trying fallback; read_url: Fetching page / Extracting; code_execute: Running. */
const TOOL_PHASE_TEXT: Record<ToolPhase, string> = {
  queued: "Queued",
  querying: "Searching",
  fallback: "Trying fallback",
  fetching: "Fetching page",
  reading: "Extracting",
  executing: "Running",
  blocked: "Network blocked",
};

/** Waiting-state text for a running tool step's `phase`, or null when it has none yet.
 * An unrecognized (newer-backend) phase degrades to a generic "Working" rather than vanishing. */
export function toolPhaseText(phase: string | undefined): string | null {
  if (!phase) return null;
  return TOOL_PHASE_TEXT[phase as ToolPhase] ?? "Working";
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
    const n = tools.length;
    return `Read page · ${n} source${n === 1 ? "" : "s"}`;
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
