/** Built-in tools that require LLM tool-calling support (开放主流AI模型接入 §4.5). */
export const TOOL_CALLING_TOOL_NAMES = new Set(["delegate", "debate"]);

/** Shown when `supports_tools === false` on delegate / debate surfaces. */
export const TOOLS_GATE_HINT = "当前模型不支持工具调用，切换模型后可用";

export function isToolsGateBlocked(
  supportsTools: boolean | null | undefined,
): boolean {
  return supportsTools === false;
}
