import {
  MemoryUpdateItemRow,
  formatMemoryTime,
  memoryScopeOverview,
  visibleMemoryUpdateItems,
} from "@/components/memory/MemoryUpdateItemRow";
import { Card } from "@/components/ui";
import { countPillMuted, statusCardChrome } from "@/components/ui/tone-presets";
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import { filesMemoryLeafNavState } from "@/services/sources/memorySource";
import type { MemoryUpdate } from "@/stores/conversation";
import { usePersistentDisclosure } from "@/stores/disclosure";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { memoryAnchorTime } from "./messageTimeline";

/**
 * Read-only leftover notice on the conversation timeline.
 *
 * Expand to see what was written; click a filename to open that leaf on the
 * files page. No row-level 纠错 / 搬层.
 *
 * - ``semantic``: expandable diff of leftover 偏好 / 画像 / 主题 files.
 * - ``quota``: the always pool is full — the summary says so and the rows name every
 *   entry that could not be written plus the ones holding the pool.
 */
export function MemoryUpdateCard({ update }: { update: MemoryUpdate }) {
  const navigate = useNavigate();
  const chrome = statusCardChrome("muted");
  const [open, setOpen] = usePersistentDisclosure(`memory:${update.id}`, false);
  const timeLabel = formatMemoryTime(memoryAnchorTime(update));

  const items = visibleMemoryUpdateItems(update.items);
  if (items.length === 0 && !(update.summary ?? "").trim()) return null;

  const openLeaf = (target: string, projectId?: string | null) => {
    navigate(APP_PATHS.files, {
      state: filesMemoryLeafNavState(target, projectId),
    });
  };

  const scopeOverview = memoryScopeOverview(items);
  const isQuota = update.kind === "quota";
  const title = isQuota
    ? (update.summary ?? "常驻条目已满")
    : items.length > 0
      ? scopeOverview
        ? `记忆已更新 · ${scopeOverview}`
        : "记忆已更新"
      : (update.summary ?? "记忆已整理");

  return (
    <Card
      className={`animate-task-card-enter ${chrome.border} ${chrome.surface}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Brain size={16} className={`shrink-0 ${chrome.accent}`} />
        <span
          className={`min-w-0 truncate text-xs font-medium ${chrome.accent}`}
        >
          {title}
        </span>
        {items.length > 0 && (
          <span className={countPillMuted}>{items.length} 项</span>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {timeLabel}
        </span>
        {items.length > 0 ? (
          open ? (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )
        ) : null}
      </button>
      {open && items.length > 0 && (
        <div className="px-3 pb-3">
          <ul className="space-y-0.5">
            {items.map((item, i) => (
              <MemoryUpdateItemRow
                key={`${item.action}:${item.file}:${item.section}:${i}`}
                item={item}
                onOpenLeaf={openLeaf}
              />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
