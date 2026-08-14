import { TabBar } from "@/components/TabBar";
// Shell for a top-level page: the page fills the body, the bottom TabBar persists below
// (手机端布局重构 · 底部 4-tab 导航). The shell owns the remaining viewport and the top
// safe-area inset (status bar); the inner page's own .screen drops to height:100% (see
// styles.css .tabs-body > .screen) and the TabBar owns the bottom safe-area (home indicator).
// Wrap ONLY top-level routes. AI 对话 `/` `/c/:id` 留底栏（开盖即聊）；设置子页 / IM 线程 /
// 会话文件预览走裸 .screen，避免和页面自己的底栏 composer 抢。
import { useKeyboardInsetBridge } from "@/lib/keyboardInsets";
import { type ReactNode, useRef } from "react";

export function TabLayout({ children }: { children: ReactNode }) {
  const shellRef = useRef<HTMLDivElement>(null);
  useKeyboardInsetBridge(shellRef);

  return (
    <div className="tabs-shell" ref={shellRef}>
      <div className="tabs-body">{children}</div>
      <TabBar />
    </div>
  );
}
