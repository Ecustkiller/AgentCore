/**
 * 回合详情收口：硬停且本回合动过工作区文件时，露出入口 + 内嵌
 * {@link TurnFileChangesReview}。无改动不渲染。
 */

import { useStoppedTurnFileChangeCount } from "@/components/chat/StoppedTurnFileChanges";
import { TurnFileChangesReview } from "@/components/chat/TurnFileChangesReview";
import { fileArtifactsFromExecution } from "@/lib/fileArtifacts";
import type { Execution } from "@/stores/execution";
import { useMemo } from "react";
import { Section } from "./shared";

export function StoppedTurnFileChangesSection({
  execution,
  conversationId,
  messageId,
}: {
  execution: Execution;
  conversationId: string;
  messageId: string;
}) {
  const artifacts = useMemo(
    () => fileArtifactsFromExecution(execution),
    [execution],
  );
  const count = useStoppedTurnFileChangeCount(
    execution,
    conversationId,
    messageId,
    execution.status === "cancelled",
  );

  if (execution.status !== "cancelled" || count <= 0) return null;

  return (
    <Section title="工作区改动">
      <p
        className="mb-2 text-xs text-muted-foreground"
        data-testid="run-detail-stopped-file-changes"
      >
        本回合已停止，改动了 {count} 个文件
      </p>
      <TurnFileChangesReview
        artifacts={artifacts}
        conversationId={conversationId}
        messageId={messageId}
        variant="panel"
      />
    </Section>
  );
}
