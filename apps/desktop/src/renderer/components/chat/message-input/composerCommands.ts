export type ComposerCommandId =
  | "skill"
  | "model"
  | "new"
  | "tasks"
  | "mcp"
  | "settings"
  | "stop";

export interface ComposerCommand {
  id: ComposerCommandId;
  label: string;
  description: string;
  keywords: string[];
  shortcut?: string;
}

export const COMPOSER_COMMANDS: ComposerCommand[] = [
  {
    id: "skill",
    label: "选择技能",
    description: "为本回合固定一个 Skill",
    keywords: ["skill", "技能", "能力"],
  },
  {
    id: "model",
    label: "切换模型",
    description: "打开当前会话的模型组合",
    keywords: ["model", "模型", "组合"],
  },
  {
    id: "new",
    label: "新对话",
    description: "保留当前草稿并开始新对话",
    keywords: ["new", "新对话", "chat"],
  },
  {
    id: "tasks",
    label: "后台任务",
    description: "查看运行中任务与待处理结果",
    keywords: ["tasks", "task", "background", "任务", "后台", "运行"],
  },
  {
    id: "mcp",
    label: "MCP 连接器",
    description: "管理本机 MCP Server",
    keywords: ["mcp", "connector", "连接器", "工具"],
  },
  {
    id: "settings",
    label: "设置",
    description: "打开设置与账户",
    keywords: ["setting", "settings", "设置", "偏好"],
  },
  {
    id: "stop",
    label: "停止生成",
    description: "停止当前回合的执行",
    keywords: ["stop", "停止", "中止"],
  },
];

/** Slash commands are only recognized at the beginning of the draft. */
export function detectSlashCommand(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const end = Math.max(0, Math.min(caret, text.length));
  const head = text.slice(0, end);
  const slash = head.lastIndexOf("/");
  if (slash < 0) return null;
  if (text.slice(0, slash).trim()) return null;
  const query = head.slice(slash + 1);
  if (/[\s\n\t]/.test(query)) return null;
  return { start: slash, query };
}

export function matchComposerCommands(query: string): ComposerCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return COMPOSER_COMMANDS;
  return COMPOSER_COMMANDS.filter((command) => {
    const haystack = [
      command.label,
      command.description,
      ...command.keywords,
    ].join(" ");
    return haystack.toLowerCase().includes(needle);
  });
}

export function removeSlashCommand(
  text: string,
  start: number,
  query: string,
): string {
  const end = Math.min(text.length, start + 1 + query.length);
  return `${text.slice(0, start)}${text.slice(end)}`;
}
