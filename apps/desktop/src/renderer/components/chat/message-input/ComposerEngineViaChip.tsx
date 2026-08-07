import { useWorkspaceModeState } from "@/components/workspace/WorkspaceModeControl";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { hasLocalEngine } from "@/lib/capabilities";
import { useConversationStore } from "@/stores/conversation";
import { useUIStore } from "@/stores/ui";
import { Cloud, Cpu } from "lucide-react";

/**
 * 轻量执行路径指示：绑本机工作区时展示「本地引擎」或「云端过桥」。
 *
 * 由 `sendTurn` 写入的 `executionVia` 驱动；开关关闭且尚未发过回合时，用开关态预示过桥。
 * 纯云会话不渲染。
 */
export function ComposerEngineViaChip({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const state = useWorkspaceModeState(conversationId);
  const executionVia = useConversationStore((s) =>
    conversationId
      ? (s.byId[conversationId]?.executionVia ?? null)
      : null,
  );
  const sidecarEnabled = useUIStore((s) => s.sidecarEnabled);

  if (!hasLocalEngine() || !conversationId) return null;
  if (!state?.effective.isLocal || state.effective.rootMissing) return null;

  const via =
    executionVia ??
    (!sidecarEnabled ? ("cloud_bridge" as const) : null);
  if (!via) return null;

  const isBridge = via === "cloud_bridge";
  const label = isBridge ? "云端过桥" : "本地引擎";
  const tip = isBridge
    ? "本机工作区，但本回合经云端引擎过桥（本地引擎关闭、暂不可用或附件等退云）"
    : "本回合在本地引擎执行（直连本机磁盘）";

  return (
    <SimpleTooltip label={tip}>
      <span
        data-testid="composer-engine-via-chip"
        className="inline-flex h-7 max-w-[140px] shrink items-center gap-1 px-1.5 text-xs text-muted-foreground"
        aria-label={label}
      >
        {isBridge ? (
          <Cloud size={12} className="shrink-0" aria-hidden />
        ) : (
          <Cpu size={12} className="shrink-0" aria-hidden />
        )}
        <span className="min-w-0 truncate">{label}</span>
      </span>
    </SimpleTooltip>
  );
}
