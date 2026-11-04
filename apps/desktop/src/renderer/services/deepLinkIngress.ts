/**
 * 深链入口（最后修订 2026-11-04）。
 *
 * 主进程收到 `nexus://` 深链后，推送一条已校验的站内路由。这里用
 * `router.navigate` 而不是让主进程 `loadURL`：同文档跳转不会重载页面，也不会
 * 丢掉用户正在编辑的草稿。web 运行时没有这个 API，静默降级为 no-op。
 */

import { router } from "@/router";

export function installDeepLinkIngress(): () => void {
  const subscribe = window.windowApi?.onDeepLink;
  if (!subscribe) return () => {};
  return subscribe((hashRoute: string) => {
    void router.navigate(hashRoute);
  });
}
