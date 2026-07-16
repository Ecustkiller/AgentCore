import type { Execution } from "@/stores/execution";
import { useCallback, useState } from "react";
import { type DebateClashView, type DebateModel, isFlatRound } from "../model";
import { CrossExamSection } from "./CrossExamSection";
import { JudgeNote } from "./JudgeNote";
import { resolveModeratorModel } from "./ModeratorIdentity";
import { OpeningNote } from "./OpeningNote";
import { SectionHeader } from "./SectionHeader";
import { SpeakerBlock, speechStageLabel } from "./SpeakerBlock";
import { SteeringPanel } from "./SteeringPanel";
import { UserInterjection } from "./UserInterjection";
import { roundAnchorId, speakerAnchorId } from "./anchors";
import {
  type DebateArenaLayout,
  partitionSides,
} from "./debateLayoutPreference";
import { openingText } from "./openingText";

export function Transcript({
  model,
  execution,
  messageId,
  conversationId,
  interactive,
  layoutMode = "stack",
}: {
  model: DebateModel;
  execution: Execution;
  messageId: string;
  conversationId: string | null;
  interactive: boolean;
  layoutMode?: DebateArenaLayout;
}) {
  const topicMotion = model.motion ?? model.rounds[0]?.focus ?? "";
  const openingLine = openingText(model);
  const moderatorModel = resolveModeratorModel(model, execution);

  const lastRoundBySideKey = new Map<string, number>();
  for (const r of model.rounds) {
    for (const s of r.sides) {
      if (s.sideKey) lastRoundBySideKey.set(s.sideKey, r.roundNo);
    }
  }

  const [highlightId, setHighlightId] = useState<string | null>(null);

  const scrollToSpeaker = useCallback(
    (clash: DebateClashView) => {
      const prevRound = lastRoundBySideKey.get(clash.toKey);
      if (!prevRound) return;
      const id = speakerAnchorId(prevRound, clash.toKey);
      setHighlightId(id);
      document.getElementById(id)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    },
    [lastRoundBySideKey],
  );

  const renderSpeakerBlock = (
    side: (typeof model.rounds)[number]["sides"][number],
    round: (typeof model.rounds)[number],
  ) => {
    const replies =
      round.roundNo >= 2
        ? round.clashes.filter((c) => c.fromKey === side.sideKey)
        : [];
    return (
      <SpeakerBlock
        key={side.key}
        side={side}
        round={round}
        execution={execution}
        messageId={messageId}
        stage={speechStageLabel(round.roundNo)}
        highlight={
          highlightId ===
          speakerAnchorId(round.roundNo, side.sideKey || side.key)
        }
        onHighlightEnd={() => setHighlightId(null)}
        clashes={replies}
        onClashClick={scrollToSpeaker}
      />
    );
  };

  const useSplit = layoutMode === "split";

  return (
    <div className="space-y-1">
      {openingLine && <OpeningNote text={openingLine} model={moderatorModel} />}

      {model.rounds.map((round) => {
        const flat = isFlatRound(round);
        const allDone =
          round.sides.length > 0 &&
          round.sides.every((s) => s.run && s.run.status !== "running");
        const showModeratorPending = round.inFlight && allDone;
        const crossExamRunning = round.crossExam.some(
          (cx) => cx.answerRun?.status === "running",
        );
        // 拟质询窗口：本场开质询 + 立论已完 + 质询问答尚未出现。
        // 小结窗口：质询作答已结束，或本场未开质询（快速对碰 / 圆桌 / 老事件缺字段）。
        const pendingKind =
          model.crossExamEnabled &&
          round.crossExam.length === 0 &&
          !crossExamRunning
            ? "cross_exam"
            : "summary";
        const focusText =
          round.focus && round.focus !== topicMotion ? round.focus : "";

        return (
          <div key={round.roundNo}>
            {!flat && round.roundNo >= 1 && (
              <SectionHeader
                id={roundAnchorId(round.roundNo)}
                label={`第 ${round.roundNo} 轮`}
                sublabel={focusText || undefined}
              />
            )}

            {round.userInterjections.map((it, i) => (
              <UserInterjection
                key={`${it.ask}-${i}`}
                interjection={it}
                sides={round.sides}
              />
            ))}

            {useSplit ? (
              <div className="grid grid-cols-2 items-start gap-4">
                {(() => {
                  const { pro, con } = partitionSides(
                    round.sides,
                    (s) => s.sideKey,
                    (s) => s.stance,
                  );
                  return (
                    <>
                      <div className="min-w-0">
                        {pro && renderSpeakerBlock(pro, round)}
                      </div>
                      <div className="min-w-0">
                        {con && renderSpeakerBlock(con, round)}
                      </div>
                    </>
                  );
                })()}
              </div>
            ) : (
              round.sides.map((side) => renderSpeakerBlock(side, round))
            )}

            {round.crossExam.length > 0 && (
              <CrossExamSection
                exchanges={round.crossExam}
                messageId={messageId}
                sceneKey={`${messageId}:cx:r${round.roundNo}`}
                layoutMode={layoutMode}
                moderatorModel={moderatorModel}
              />
            )}

            {round.summary && !round.inFlight ? (
              <JudgeNote
                text={round.summary}
                round={round}
                form={model.form}
                model={moderatorModel}
              />
            ) : (
              showModeratorPending &&
              !crossExamRunning && (
                <JudgeNote
                  text=""
                  pending
                  pendingKind={pendingKind}
                  model={moderatorModel}
                />
              )
            )}
          </div>
        );
      })}

      <SteeringPanel
        model={model}
        execution={execution}
        conversationId={conversationId}
        interactive={interactive}
      />
    </div>
  );
}
