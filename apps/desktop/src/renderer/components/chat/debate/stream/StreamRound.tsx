import { Button } from "@/components/ui";
import { statusPillInline } from "@/components/ui/tone-presets";
import type { Execution } from "@/stores/execution";
import { Columns2, List } from "lucide-react";
import {
  type DebateForm,
  type DebateRoundModel,
  type DebateSideModel,
  isFlatRound,
} from "../model";
import { InterjectionBubble } from "./AskBubble";
import { CrossExamBlock } from "./CrossExam";
import {
  ModeratorNote,
  ModeratorPending,
  ModeratorSpeech,
} from "./Moderator";
import { SpeechBubble } from "./SpeechBubble";

/** 轮分割线（居中）：第 N 轮 + 焦点（与辩题同文则省）+ 进行中 pill。 */
function RoundDivider({
  round,
  topicMotion,
  hideFocus,
}: {
  round: DebateRoundModel;
  topicMotion?: string;
  hideFocus?: boolean;
}) {
  const focusText =
    !hideFocus && round.focus && round.focus !== topicMotion ? round.focus : "";
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="h-px flex-1 bg-border" />
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          第 {round.roundNo} 轮
        </span>
        {focusText && (
          <span className="max-w-[20rem] truncate">· {focusText}</span>
        )}
        {round.inFlight && (
          <span className={statusPillInline.primary}>进行中</span>
        )}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** 一轮：轮分割线 → 用户追问（右侧·驱动本轮）→ 各方发言气泡（左·引用回复）→ 主持人发言气泡（左）。 */
export function StreamRound({
  round,
  execution,
  messageId,
  topicMotion,
  form,
  moderatorModel,
  lastRoundBySideKey,
  versus,
  parallel,
  onToggleParallel,
}: {
  round: DebateRoundModel;
  execution: Execution;
  messageId: string;
  topicMotion?: string;
  form: DebateForm;
  moderatorModel: string;
  lastRoundBySideKey: Map<string, number>;
  versus: boolean;
  parallel: boolean;
  onToggleParallel: (next: boolean) => void;
}) {
  const flat = isFlatRound(round);
  const allDone =
    round.sides.length > 0 &&
    round.sides.every((s) => s.run && s.run.status !== "running");
  const showModeratorPending = round.inFlight && allDone;
  const showFraming =
    !flat && round.roundNo >= 2 && !!round.focus && round.focus !== topicMotion;
  const pro = round.sides.find((s) => s.stance === "pro") ?? null;
  const con = round.sides.find((s) => s.stance === "con") ?? null;
  const canParallel = versus && !!pro && !!con;
  const parallelView = canParallel && parallel;
  const showStanceFor = (side: DebateSideModel) =>
    !!side.sideKey && lastRoundBySideKey.get(side.sideKey) === round.roundNo;
  return (
    <div className="space-y-2.5">
      {!flat && round.roundNo >= 1 && (
        <RoundDivider
          round={round}
          topicMotion={topicMotion}
          hideFocus={showFraming}
        />
      )}
      {showFraming && (
        <ModeratorNote
          moderatorModel={moderatorModel}
          text={`这一轮我们把焦点转到「${round.focus}」。`}
        />
      )}
      {canParallel && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            onClick={() => onToggleParallel(!parallelView)}
            aria-pressed={parallelView}
            icon={parallelView ? <List size={13} /> : <Columns2 size={13} />}
            className="h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {parallelView ? "收起并排" : "并排看此轮"}
          </Button>
        </div>
      )}
      {round.userInterjections.map((it, i) => (
        <InterjectionBubble
          key={`${it.ask}-${i}`}
          interjection={it}
          sides={round.sides}
        />
      ))}
      {parallelView && pro && con ? (
        <div className="grid grid-cols-2 items-start gap-2">
          <SpeechBubble
            side={pro}
            round={round}
            execution={execution}
            messageId={messageId}
            showStance={showStanceFor(pro)}
            column
            align="left"
          />
          <SpeechBubble
            side={con}
            round={round}
            execution={execution}
            messageId={messageId}
            showStance={showStanceFor(con)}
            column
            align="right"
          />
        </div>
      ) : (
        round.sides.map((side) => (
          <SpeechBubble
            key={side.key}
            side={side}
            round={round}
            execution={execution}
            messageId={messageId}
            showStance={showStanceFor(side)}
          />
        ))
      )}
      {round.crossExam.length > 0 && (
        <CrossExamBlock
          exchanges={round.crossExam}
          execution={execution}
          messageId={messageId}
          moderatorModel={moderatorModel}
          sceneKey={`${messageId}:dxexam:r${round.roundNo}`}
        />
      )}
      {round.summary && !round.inFlight ? (
        <ModeratorSpeech
          round={round}
          form={form}
          moderatorModel={moderatorModel}
        />
      ) : (
        showModeratorPending && <ModeratorPending />
      )}
    </div>
  );
}
