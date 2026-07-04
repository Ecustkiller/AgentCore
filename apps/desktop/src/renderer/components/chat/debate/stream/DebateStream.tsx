import { usePersistentDisclosure } from "@/stores/disclosure";
import type { Execution } from "@/stores/execution";
import { useRef, useState } from "react";
import { DebateContinue } from "../Continue";
import { type DebateModel, debateRoster, toDebateModel } from "../model";
import { ClosingSection } from "./ClosingSection";
import { FinalVerdict } from "./FinalVerdict";
import { FlowToolbar } from "./FlowToolbar";
import { ModeratorNote } from "./Moderator";
import { StreamRound } from "./StreamRound";
import { openingText } from "./openingText";

/** 阅读列宽：`chat` 对齐对话页 768px；`canvas` 对齐画布放大态长文/对照档 1024px。 */
export type DebateReadingWidth = "chat" | "canvas";

const READING_WIDTH_CLASS: Record<DebateReadingWidth, string> = {
  chat: "max-w-3xl",
  canvas: "max-w-5xl",
};

/**
 * 统一辩论室（IM 群聊）—— 把整场辩论收敛成**单条群聊时间线**，按**自然时序**排布。
 * 纯渲染层、不碰协议 fold / conformance。
 */
export function DebateStream({
  execution,
  messageId,
  initialParallel = false,
  readingWidth = "chat",
}: {
  execution: Execution;
  messageId: string;
  initialParallel?: boolean;
  /** 默认 `chat`；画布放大态传 `canvas` 与修订对比同档（`max-w-5xl`）。 */
  readingWidth?: DebateReadingWidth;
}) {
  const model = toDebateModel(execution);
  if (!model) return null;
  return (
    <DebateStreamInner
      model={model}
      execution={execution}
      messageId={messageId}
      initialParallel={initialParallel}
      readingWidth={readingWidth}
    />
  );
}

function DebateStreamInner({
  model,
  execution,
  messageId,
  initialParallel,
  readingWidth,
}: {
  model: DebateModel;
  execution: Execution;
  messageId: string;
  initialParallel: boolean;
  readingWidth: DebateReadingWidth;
}) {
  const topicMotion = model.motion ?? model.rounds[0]?.focus ?? "";
  const openingLine = openingText(model);
  const verdictRef = useRef<HTMLDivElement>(null);
  const moderatorModel =
    (model.moderatorRunId
      ? execution.runs.find((r) => r.id === model.moderatorRunId)?.model
      : null) ?? "";
  const lastRoundBySideKey = new Map<string, number>();
  for (const r of model.rounds) {
    for (const s of r.sides) {
      if (s.sideKey) lastRoundBySideKey.set(s.sideKey, r.roundNo);
    }
  }

  const isVersus =
    model.form === "debate" && debateRoster(model.rounds).length === 2;

  const [globalParallel, setGlobalParallel] = usePersistentDisclosure(
    `${messageId}:debate:parallel`,
    isVersus || initialParallel,
  );
  const [roundParallel, setRoundParallel] = useState<Record<number, boolean>>(
    {},
  );
  const parallelFor = (roundNo: number) =>
    roundParallel[roundNo] ?? globalParallel;
  const setGlobalParallelMode = (on: boolean) => {
    setGlobalParallel(on);
    setRoundParallel({});
  };
  const setRoundParallelOverride = (roundNo: number, next: boolean) =>
    setRoundParallel((prev) => ({ ...prev, [roundNo]: next }));

  return (
    <div className="w-full">
      <div
        className={`mx-auto flex ${READING_WIDTH_CLASS[readingWidth]} flex-col gap-3`}
      >
        <FlowToolbar
          isVersus={isVersus}
          globalParallel={globalParallel}
          onSetParallel={setGlobalParallelMode}
          settled={model.settled}
          onScrollVerdict={() =>
            verdictRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            })
          }
        />
        <div className="space-y-4">
          {openingLine && (
            <ModeratorNote moderatorModel={moderatorModel} text={openingLine} />
          )}
          {model.rounds.map((round) => (
            <StreamRound
              key={round.roundNo}
              round={round}
              execution={execution}
              messageId={messageId}
              topicMotion={topicMotion}
              form={model.form}
              moderatorModel={moderatorModel}
              lastRoundBySideKey={lastRoundBySideKey}
              versus={isVersus}
              parallel={parallelFor(round.roundNo)}
              onToggleParallel={(next) =>
                setRoundParallelOverride(round.roundNo, next)
              }
            />
          ))}
        </div>

        {model.settled && model.closings.length > 0 && (
          <ClosingSection
            closings={model.closings}
            execution={execution}
            messageId={messageId}
          />
        )}

        {model.settled && (
          <>
            <FinalVerdict
              model={model}
              execution={execution}
              messageId={messageId}
              verdictRef={verdictRef}
            />
            <DebateContinue model={model} />
          </>
        )}
      </div>
    </div>
  );
}

export { AskBubble, InterjectionBubble } from "./AskBubble";
export { ModeratorAvatar } from "./Moderator";
