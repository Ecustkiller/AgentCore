import { SimpleTooltip } from "@/components/ui/tooltip";
import type { Message } from "@/stores/conversation";
import { Check, CloudOff } from "lucide-react";

/**
 * Local-only outbox sync caption on optimistic bubbles (as-built: 前端 UX §一B).
 * Never serialized to SSE / REST / conformance.
 */
export function SyncStatusHint({
  syncStatus,
  align = "start",
}: {
  syncStatus: Message["syncStatus"];
  align?: "start" | "end";
}) {
  if (!syncStatus) return null;

  const pending = syncStatus === "synced_pending";
  const label = pending ? "待同步" : "已同步";
  const tip = pending ? "本机已保存，正在同步到云端" : "已同步到云端";

  return (
    <SimpleTooltip label={tip}>
      <span
        className={`inline-flex items-center gap-1 text-xs ${
          pending ? "text-muted-foreground" : "text-success"
        } ${align === "end" ? "justify-end" : ""}`}
        data-testid={`sync-status-${syncStatus}`}
        aria-label={label}
      >
        {pending ? <CloudOff size={12} /> : <Check size={12} />}
        {label}
      </span>
    </SimpleTooltip>
  );
}
