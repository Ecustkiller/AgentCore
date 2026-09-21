/** Human-readable section titles for prompt XML tags (server-side section markers). */
export const PROMPT_TAG_LABELS: Record<string, string> = {
  身份: "身份",
  输入: "输入",
  工作权威: "工作权威",
  诚实: "诚实",
  输出: "输出",
  设定: "设定",
  工作区: "工作区",
  按需目录: "按需目录",
  output_style: "输出风格",
  tool_use: "工具使用",
  system_feedback: "系统反馈",
  runtime_context: "运行时上下文",
  citing_sources: "引用规范",
  visualization: "可视化",
  role: "角色",
  how_you_work: "工作方式",
  platform_knowledge: "平台知识边界",
  rules: "规则",
  能力目录: "能力目录",
  记忆主题目录: "记忆主题目录",
  workspace_file_index: "工作区文件索引",
  tool_safety: "工具安全",
  local_desk: "本机路径与工作区",
  本机目录: "本机路径与工作区",
  debate_and_review: "正反辩论",
  page_ui: "页面观感",
};

/** Resolve a prompt section tag to a display title. */
export function labelForPromptTag(tag: string): string {
  const known = PROMPT_TAG_LABELS[tag];
  if (known) return known;
  return tag.replace(/_/g, " ");
}
