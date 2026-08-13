import { PageContainer } from "@/components/layout/PageContainer";
import { ToolboxPageHeader } from "@/components/toolbox/ToolboxPageHeader";
import { cn } from "@/lib/utils";
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import { useStandingInboxBadge } from "@/stores/standingInbox";
import { NavLink, Outlet } from "react-router-dom";

/** Counts above this render as `99+` so a tab can't stretch. */
const MAX_BADGE = 99;

const TABS = [
  {
    id: "tasks",
    label: "任务",
    to: APP_PATHS.toolbox.automations.root,
    end: true,
    badge: false,
  },
  {
    id: "inbox",
    label: "收件箱",
    to: APP_PATHS.toolbox.automations.inbox,
    end: false,
    badge: true,
  },
] as const;

/**
 * 工具箱 · 自动化专页壳：任务 | 收件箱（子路径深链）。
 *
 * 一级导航（工具箱五页）由 `ToolboxPageHeader` 统一承担；页内这层用下划线 tab，
 * 与页头的 pill 分段形态错开，两级层次一眼可辨。
 */
export function AutomationsPage() {
  const inboxBadge = useStandingInboxBadge();

  return (
    <PageContainer width="canvas">
      {/* 下面这条下划线 tab 自带基线，页头再画一条就成了两条叠在一起的横线。 */}
      <ToolboxPageHeader bordered={false} />

      <nav
        aria-label="自动化分区"
        className="flex items-center gap-4 border-b border-border"
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.id}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                "relative inline-flex h-9 items-center gap-1.5 text-sm transition-colors",
                isActive
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                {tab.label}
                {tab.badge && inboxBadge > 0 ? (
                  <span
                    aria-label={`${inboxBadge} 条待处理`}
                    className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/10 px-1 text-xs font-medium text-primary"
                  >
                    {inboxBadge > MAX_BADGE ? `${MAX_BADGE}+` : inboxBadge}
                  </span>
                ) : null}
                {isActive ? (
                  // 画成背景条而非 border：globals.css 的无层级 `*
                  // { border-color: var(--border) }` 会盖掉所有 border 色工具类。
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 -bottom-px h-0.5 bg-primary"
                  />
                ) : null}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-6">
        <Outlet />
      </div>
    </PageContainer>
  );
}
