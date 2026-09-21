import { type SectionTabItem, SectionTabs } from "@/components/ui";
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import type { ReactNode } from "react";

function sourceItems(): SectionTabItem[] {
  const items: SectionTabItem[] = [
    { to: APP_PATHS.toolbox.official, label: "官方", end: true },
    { to: APP_PATHS.toolbox.guidelines, label: "我的", end: true },
  ];
  if (typeof window !== "undefined" && window.mcpApi) {
    items.push({ to: APP_PATHS.toolbox.mcp, label: "MCP", end: true });
  }
  items.push({ to: APP_PATHS.toolbox.market, label: "市场", end: true });
  return items;
}

/**
 * 工具箱顶栏：官方 / 我的 / MCP / 市场。MCP 只在有本机通道时出现。
 * 可见标题不画（侧栏已点名）；h1 只给读屏和滚动锚。
 */
export function ToolboxSourceTabs({ action }: { action?: ReactNode }) {
  return (
    <div className="shrink-0">
      <h1 className="sr-only">工具箱</h1>
      <SectionTabs aria-label="工具箱" items={sourceItems()} action={action} />
    </div>
  );
}
