/**
 * 右坞 run 详情 · 单人停止入口。
 * 复用协作图的 requestRunStop + pending store（scope: node）；不假装 run 已停。
 */

import {
  isStoppableRunStatus,
  requestRunStop,
} from "@/components/graph/runStopActions";
import { Button } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useRunStopPendingStore } from "@/stores/runStopPending";
import { Square } from "lucide-react";
import { useEffect, useState } from "react";

export function RunMemberStopButton({
  conversationId,
  executionId,
  runId,
  runStatus,
}: {
  conversationId: string;
  executionId: string;
  runId: string;
  runStatus: string;
}) {
  const covered = useRunStopPendingStore((s) =>
    s.isRunCovered(executionId, runId),
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    useRunStopPendingStore
      .getState()
      .clearIfSettled(executionId, runId, runStatus);
  }, [executionId, runId, runStatus]);

  if (!isStoppableRunStatus(runStatus)) return null;

  const busy = covered || submitting;
  const stopLabel = busy ? "停止请求中…" : "停止这位队员";

  return (
    <SimpleTooltip
      label={
        busy
          ? "停止请求已发出，等待引擎确认（节点状态会随后更新）"
          : "只停这位队员的工作；主 Agent 与对话继续（不是结束整轮）"
      }
    >
      <Button
        type="button"
        variant="ghost"
        className="h-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        icon={<Square size={13} />}
        disabled={busy}
        aria-label={stopLabel}
        onClick={async () => {
          if (busy) return;
          setSubmitting(true);
          try {
            await requestRunStop({
              conversationId,
              executionId,
              runId,
              scope: "node",
            });
          } finally {
            setSubmitting(false);
          }
        }}
      >
        {stopLabel}
      </Button>
    </SimpleTooltip>
  );
}
