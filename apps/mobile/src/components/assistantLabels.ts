// Shared chrome labels for assistant rendering (中文工具名 / 上下文通道名 + the arg-detail
// picker). Extracted so BOTH the inline timeline ({@link AssistantView}) and the per-worker
// run-detail panel ({@link TeamView} · RunDetail) read ONE source — the maps are the kind of
// chrome that silently drifts if copied. Pure data + string helpers, no JSX, so it stays a
// leaf both can import without an import cycle (AssistantView → TeamView → RunDetail → here).
//
// These mirror the desktop `TOOL_META` / `CONTEXT_CHANNEL_META` labels so the two ends read the
// same (各端全新建 per cross-platform-frontend; labels are chrome, NOT shared business logic).

import type { ToolPhase } from "@agentcore/contract-types";

/** Context channel → 中文 label (上下文传递可视化). Covers the CEO-side opening channels
 *  (系统提示 / 对话历史 / 原始请求 / 队员回传) and the worker-side / 续写 channels (任务 / 交付物 /
 *  前置结果 / 本轮焦点 …). An unknown channel falls back to its raw name. */
export const CONTEXT_CHANNEL_LABEL: Record<string, string> = {
  system: "系统提示",
  history: "对话历史",
  request: "原始请求",
  team_position: "团队位置",
  dependency: "前置结果",
  workspace: "工作区",
  task: "你的任务",
  deliverable: "交付物规格",
  team_brief: "团队共识",
  steer: "中途指示",
  team_result: "队员回传",
  round_focus: "本轮焦点",
  opponent: "对方论点",
  challenge: "被驳命门",
  interjection: "你的追问",
  continuation: "接续指令",
  cross_exam: "质询",
  closing: "结辩",
};

/** 中文工具名 — an unknown tool falls back to its raw backend name so a newly added tool still
 *  renders (just untranslated). */
const TOOL_LABEL: Record<string, string> = {
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
  delegate: "委派任务",
  ask_user: "向你确认",
  consult_skill: "查阅能力",
  escalate: "上报问题",
};

export const toolLabel = (name: string): string => TOOL_LABEL[name] ?? name;

/** 工具执行阶段进度 → 等待态文案 (联网前端展示优化). Mirrors desktop `toolPhaseText`. */
const TOOL_PHASE_TEXT: Record<ToolPhase, string> = {
  queued: "排队中",
  querying: "正在检索",
  fallback: "改用备用引擎",
  fetching: "正在抓取网页",
  reading: "正在提取正文",
  executing: "正在执行",
  blocked: "出网受限",
};

export function toolPhaseText(phase: string | undefined): string | null {
  if (!phase) return null;
  return TOOL_PHASE_TEXT[phase as ToolPhase] ?? "处理中";
}

/** The most descriptive string arg to show beside a tool (its query / url / path / …);
 *  empty when the call carries no representative string arg. */
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
