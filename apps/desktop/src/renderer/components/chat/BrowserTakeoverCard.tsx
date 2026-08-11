import { formatMemoryTime } from "@/components/memory/MemoryUpdateItemRow";
import { formatTakeoverDuration } from "@/services/browserTakeover";
import type { BrowserTakeover } from "@/stores/browserTakeover";
import { Hand } from "lucide-react";

/**
 * L3「团队浏览器」M2 接管标记卡（提案 D17）——时间线上的小型只读留档。
 *
 * 时间线 ghost 行（与已结算确认条同族；记忆/摘要卡仍用带边框 Card）：一行
 * 「用户接管了浏览器 · N分M秒」+ 起始时刻。接管期间零帧落盘（帧可能含明文凭据），
 * 只落起止两条 DURABLE 标记；本卡即其可视化，聊天流可见、刷新/回放可重建（数据在表里，
 * 见 {@link import("@/stores/browserTakeover")}）。`endedAt` 为空（异常未归还）时退化为无时长文案。
 */
export function BrowserTakeoverCard({
  takeover,
}: {
  takeover: BrowserTakeover;
}) {
  const durationText =
    takeover.endedAt != null
      ? ` · ${formatTakeoverDuration(
          Date.parse(takeover.endedAt) - Date.parse(takeover.startedAt),
        )}`
      : "";
  return (
    <div className="animate-task-card-enter">
      <div className="flex w-full items-center gap-2 py-1 text-left text-xs text-muted-foreground">
        <Hand size={16} className="shrink-0" />
        <span className="font-medium">{`用户接管了浏览器${durationText}`}</span>
        <span className="ml-auto shrink-0">
          {formatMemoryTime(takeover.startedAt)}
        </span>
      </div>
    </div>
  );
}
