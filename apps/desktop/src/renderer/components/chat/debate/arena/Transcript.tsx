import type { Execution } from "@/stores/execution";
import { useCallback, useState } from "react";
import { type DebateClashView, type DebateModel, isFlatRound } from "../model";
import { CrossExamSection } from "./CrossExamSection";
import { JudgeNote } from "./JudgeNote";
import { OpeningNote } from "./OpeningNote";
import { SectionHeader } from "./SectionHeader";
import { SpeakerBlock, speechStageLabel } from "./SpeakerBlock";
import { SteeringPanel } from "./SteeringPanel";
import { UserInterjection } from "./UserInterjection";
import { roundAnchorId, speakerAnchorId } from "./anchors";
import {
  type DebateArenaLayout,
  partitionProCon,
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
      {openingLine && <OpeningNote text={openingLine} />}

      {model.rounds.map((round) => {
        const flat = isFlatRound(round);
        const allDone =
          round.sides.length > 0 &&
          round.sides.every((s) => s.run && s.run.status !== "running");
        const showModeratorPending = round.inFlight && allDone;
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
                  const { pro, con } = partitionProCon(round.sides);
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
                execution={execution}
                messageId={messageId}
                sceneKey={`${messageId}:cx:r${round.roundNo}`}
                layoutMode={layoutMode}
              />
            )}

            {round.summary && !round.inFlight ? (
              <JudgeNote text={round.summary} round={round} form={model.form} />
            ) : (
              showModeratorPending && <JudgeNote text="" pending />
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
