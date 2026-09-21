import { PageContainer } from "@/components/layout/PageContainer";
import { Outlet } from "react-router-dom";

/**
 * 工具箱壳：目录画布。顶栏 / 搜索 / 新建在各栏，不画可见标题。
 * 不把提示词 / 出厂工具拆成种类 tab。MCP 是独立路由。手册入口在设置 · 关于。
 */
export function ToolboxShell() {
  return (
    <PageContainer width="canvas" padding="page">
      <Outlet />
    </PageContainer>
  );
}
