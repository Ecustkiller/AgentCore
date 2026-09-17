import { Button } from "@/components/ui";
import type { Execution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { Suspense } from "react";
import { type DebateModel, stopLabel } from "../model";
import { finaleAnchorId } from "./anchors";
import { DebateBrief } from "./brief";
import { ReplayBriefCard } from "./replayLazy";

export function FinaleStage({
  model,
  execution,
  messageId,
}: {
  model: DebateModel;
  execution: Execution;
  messageId: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const moderatorRun = model.moderatorRunId
    ? execution.runs.find((r) => r.id === model.moderatorRunId)
    : undefined;
  const brief = model.brief;
  const sides = model.sides;

  return (
    <div
      id={finaleAnchorId()}
      className="scroll-mt-28 mt-8 border-t-2 border-border pt-6"
    >
      {/* 终审区恒定 max-w-3xl 居中（split 并排下也不随 max-w-7xl 通栏）。 */}
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-center gap-2">
          {moderatorRun ? (
            // 点标题打开主持人 run；模型名走协作图 / 用量，终审与顶栏都不挂徽章。
            <Button
              variant="ghost"
              onClick={() =>
                showRunDetail(messageId, moderatorRun.id, "主持人")
              }
              className="h-auto justify-start gap-2 rounded-none px-0 py-0 hover:bg-transparent"
            >
              <h2 className="text-xl font-semibold text-foreground">
                主持人终审
              </h2>
            </Button>
          ) : (
            <h2 className="text-xl font-semibold text-foreground">
              主持人终审
            </h2>
          )}
          <span className="text-xs text-muted-foreground">
            {stopLabel(model.stopReason)}
          </span>
        </div>

        {brief && sides ? (
          <div className="mt-4 space-y-4">
            {model.form === "red_team" || model.form === "roundtable" ? (
              <Suspense fallback={null}>
                <ReplayBriefCard
                  brief={brief}
                  sides={sides}
                  form={model.form}
                  subtopics={model.subtopics}
                />
              </Suspense>
            ) : (
              <DebateBrief brief={brief} sides={sides} />
            )}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">结论简报生成中…</p>
        )}
      </div>
    </div>
  );
}
