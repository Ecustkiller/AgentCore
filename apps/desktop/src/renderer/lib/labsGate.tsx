/**
 * opt-in 路由守卫（最后修订 2026-11-04）。
 *
 * 上游 `98ea13bf` 卸掉「人侧文档/表格编辑器」后，相关页面仍在树里但 router
 * 不再引用。默认状态必须与上游一致：这些路径收向 `/files`、侧栏无入口。
 * 开关打开才放行。守卫放在 element 而不是路由表里，切换后无需刷新。
 *
 * 独立成文件是为了让测试只依赖守卫本身，不必把整个 hash router（以及它
 * 拉进来的画布等渲染依赖）装进 jsdom。
 */

import { useHumanDocsTablesEnabled } from "@/lib/labsFlags";
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

export function HumanDocsTablesGate({ children }: { children: ReactNode }) {
  const enabled = useHumanDocsTablesEnabled();
  if (!enabled) return <Navigate to={APP_PATHS.files} replace />;
  return <>{children}</>;
}
