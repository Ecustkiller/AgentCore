import {
  MemoryUpdateItemRow,
  formatMemoryTime,
  visibleMemoryUpdateItems,
} from "@/components/memory/MemoryUpdateItemRow";
import { Card } from "@/components/ui";
import { countPillMuted, statusCardChrome } from "@/components/ui/tone-presets";
import type { MemoryUpdate } from "@/stores/conversation";
import { usePersistentDisclosure } from "@/stores/disclosure";
import { ChevronDown, ChevronRight, CircleAlert } from "lucide-react";
import { memoryAnchorTime } from "./messageTimeline";

/**
 * Always-on user-rule quota notice on the conversation timeline.
 *
 * ``quota``: the always-on user-rule pool is full — the summary says so and the
 * rows name every entry that could not be written plus the ones holding the pool.
 * Semantic leftover-memory cards are not shown.
 */
export function MemoryUpdateCard({ update }: { update: MemoryUpdate }) {
  const chrome = statusCardChrome("muted");
  const [open, setOpen] = usePersistentDisclosure(`memory:${update.id}`, false);
  const timeLabel = formatMemoryTime(memoryAnchorTime(update));

  if (update.kind !== "quota") return null;

  const items = visibleMemoryUpdateItems(update.items);
  if (items.length === 0 && !(update.summary ?? "").trim()) return null;

  const title = update.summary?.trim() || "常驻用户规则已满";

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
        <CircleAlert size={16} className={`shrink-0 ${chrome.accent}`} />
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
              />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
