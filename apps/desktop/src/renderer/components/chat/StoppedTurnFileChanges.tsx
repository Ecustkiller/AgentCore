/**
 * 硬停后工作区改动入口 —— StatusStrip「已停止」条 + 回合详情收口区共用。
 * 只做「露出入口 + 文件数」；真 diff / 回滚仍走 {@link TurnFileChangesReview}。
 * 无改动 → 不渲染（禁空壳）。零 LLM、不写 captain 正文。
 */

import { Button } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useConversationWorkspace } from "@/hooks/useWorkspaces";
import { fileArtifactsFromExecution } from "@/lib/fileArtifacts";
import {
  getLocalTurnFilesDiff,
  getTurnFilesDiff,
} from "@/services/turnFilesDiff";
import { useConversationStore } from "@/stores/conversation";
import { type Execution, useExecutionScope } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { Diff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/**
 * 停止回合的工作区改动文件数：优先回合基线真 diff；无基线则降级工具成功产物数。
 * 探测中且尚无产物 → 0（保持静默，不闪空壳）。
 */
export function useStoppedTurnFileChangeCount(
  execution: Execution,
  conversationId: string | null,
  messageId: string | null,
  enabled: boolean,
): number {
  const artifacts = useMemo(
    () => fileArtifactsFromExecution(execution),
    [execution],
  );
  const ws = useConversationWorkspace(conversationId);
  const [baselineTotal, setBaselineTotal] = useState<number | null>(null);
  const [baselineReady, setBaselineReady] = useState(!enabled);

  useEffect(() => {
    if (!enabled || !conversationId || !messageId) {
      setBaselineTotal(null);
      setBaselineReady(true);
      return;
    }
    let cancelled = false;
    setBaselineReady(false);
    const isLocal = ws?.location === "local" && !!ws.rootId;
    const load = isLocal
      ? getLocalTurnFilesDiff(
          { rootId: ws.rootId as string, subpath: ws.subpath ?? "" },
          messageId,
        )
      : getTurnFilesDiff(conversationId, messageId);
    void load
      .then((diff) => {
        if (cancelled) return;
        setBaselineTotal(diff.available ? diff.total : null);
        setBaselineReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setBaselineTotal(null);
          setBaselineReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    conversationId,
    messageId,
    ws?.location,
    ws?.rootId,
    ws?.subpath,
  ]);

  if (!enabled) return 0;
  if (baselineReady && baselineTotal != null) return baselineTotal;
  return artifacts.length;
}

/** StatusStrip「已停止」旁的改动 chip → 右坞「改动」tab（TurnFileChangesReview）。 */
export function StoppedTurnFileChangesChip({
  execution,
}: {
  execution: Execution;
}) {
  const messageId = useExecutionScope();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const showChanges = useSidePanelStore((s) => s.showChanges);
  const count = useStoppedTurnFileChangeCount(
    execution,
    conversationId,
    messageId,
    true,
  );

  if (count <= 0 || !messageId) return null;

  return (
    <SimpleTooltip label="在右坞查看本回合相对基线的文件改动（可回滚）">
      <Button
        variant="ghost"
        className="ml-0.5 shrink-0 text-muted-foreground hover:text-foreground"
        icon={<Diff size={13} />}
        onClick={() => showChanges(messageId)}
        aria-label={`查看改动 ${count} 个文件`}
        data-testid="status-strip-stopped-file-changes"
      >
        改动 {count} 个文件
      </Button>
    </SimpleTooltip>
  );
}
