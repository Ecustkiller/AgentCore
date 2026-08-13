import { SegmentedNav, type SegmentedNavItem } from "@/components/ui";
import { artifactColorVar } from "@/lib/catalogColors";
import { cn } from "@/lib/utils";
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import { useStandingInboxBadge } from "@/stores/standingInbox";
import {
  ChevronLeft,
  Plug,
  ScrollText,
  Timer,
  Workflow,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * 工具箱「能力」组五页 —— 顺序与 `ToolboxPage` 首页卡片一致，
 * 图标与语义色同源，让磁贴和子页读作同一个身份色。
 */
export const TOOLBOX_SEGMENTS: readonly SegmentedNavItem[] = [
  {
    id: "tools",
    label: "工具",
    to: APP_PATHS.toolbox.tools,
    icon: Wrench,
    colorVar: artifactColorVar("tools"),
  },
  {
    id: "guidelines",
    label: "AI 提示词",
    to: APP_PATHS.toolbox.guidelines,
    icon: ScrollText,
    colorVar: artifactColorVar("guidelines"),
  },
  {
    id: "automations",
    label: "自动化",
    to: APP_PATHS.toolbox.automations.root,
    icon: Timer,
    colorVar: artifactColorVar("workflow"),
  },
  {
    id: "workflows",
    label: "工作流",
    to: APP_PATHS.toolbox.workflows.root,
    icon: Workflow,
    colorVar: artifactColorVar("workflow"),
  },
  {
    id: "connectors",
    label: "连接器",
    to: APP_PATHS.toolbox.connectors,
    icon: Plug,
    colorVar: artifactColorVar("connectors"),
  },
];

export interface ToolboxPageHeaderProps {
  /** 页级动作（新建 / 刷新…），落在这一行最右端。 */
  actions?: ReactNode;
  /**
   * 页头下边框。页内紧跟着自带基线的二级导航（自动化的下划线 tab）时传 `false`，
   * 否则两条横线会叠在一起。
   */
  bordered?: boolean;
  className?: string;
}

/**
 * 工具箱能力子页统一页头：返回链接、能力分段条、页级动作同占一行。
 * 不设 h1——当前位置由分段高亮承担，五页之间可直接横跳。
 */
export function ToolboxPageHeader({
  actions,
  bordered = true,
  className,
}: ToolboxPageHeaderProps) {
  const inboxBadge = useStandingInboxBadge();
  const items = TOOLBOX_SEGMENTS.map((segment) =>
    segment.id === "automations"
      ? {
          ...segment,
          badge: inboxBadge,
          badgeLabel: `${inboxBadge} 条待处理`,
        }
      : segment,
  );

  return (
    <header
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2",
        bordered ? "mb-6 border-b border-border pb-4" : "mb-4",
        className,
      )}
    >
      {/* 返回链接与分段条捆成一组，让动作插槽成为唯一会换行的元素——散着放时
          flex 按各自 max-content 断行，先换下去的会是分段条，「返回链接独占一行」
          就又回来了。窄窗口的收缩阶梯：动作掉第二行 → SegmentedNav 自己横向滚。 */}
      <div className="flex min-w-0 items-center gap-3">
        <Link
          to={APP_PATHS.toolbox.root}
          className="inline-flex h-8 shrink-0 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft size={16} />
          工具箱
        </Link>
        {/* 竖线把返回链接与分段条隔开，否则「工具箱」会读成第六个分段项。
            画成 bg 而非 border：globals.css 的无层级 `* { border-color }` 会盖掉 border 色。 */}
        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
        <SegmentedNav aria-label="工具箱能力" items={items} />
      </div>

      {actions ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
