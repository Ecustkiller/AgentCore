import { toolMeta } from "@/components/chat/message-bubble/constants";
import {
  collectFailedToolNames,
  formatUnproductiveToolFailureHint,
  shouldShowUnproductiveToolFailureHint,
} from "@/lib/unproductiveToolFailureHint";
import type { ExecutionJournal } from "@/stores/execution/types";
import type { ProcessStep } from "@/types/events";
import { AlertTriangle } from "lucide-react";

/**
 * B′：气泡工具失败轻量可见条——有正文的 unproductive 假完成拆穿。
 * 不改正文；空正文失败卡路径不渲染（避免叠刺眼第二卡）。
 */
export function UnproductiveToolFailureHint({
  finishReason,
  content,
  process,
  journal,
}: {
  finishReason: string | undefined;
  content: string | undefined;
  process: ProcessStep[] | undefined;
  journal?: ExecutionJournal | null;
}) {
  const failedToolNames = collectFailedToolNames(process, journal);
  if (
    !shouldShowUnproductiveToolFailureHint({
      finishReason,
      content,
      failedToolNames,
    })
  ) {
    return null;
  }
  const text = formatUnproductiveToolFailureHint(
    failedToolNames,
    (name) => toolMeta(name).label,
  );
  if (!text) return null;

  return (
    <output
      className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      data-testid="unproductive-tool-failure-hint"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </output>
  );
}
