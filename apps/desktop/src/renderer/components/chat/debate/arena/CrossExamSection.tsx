import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui";
import {
  usePersistentDisclosure,
  useStreamAwareDisclosure,
} from "@/stores/disclosure";
import type { Execution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  TriangleAlert,
} from "lucide-react";
import { CollapsibleSpeech } from "../CollapsibleSpeech";
import type {
  DebateCrossExamExchangeView,
  DebateCrossExamView,
} from "../model";
import type { DebateArenaLayout } from "./debateLayoutPreference";
import { summarizeText } from "./parseSpeechArguments";

const ANSWER_SUMMARY_LEN = 30;

/** 质询小节：与立论区同视觉语言；split 时按方入列，问题完整展示、回答默认折叠。 */
export function CrossExamSection({
  exchanges,
  execution,
  messageId,
  sceneKey,
  layoutMode = "stack",
}: {
  exchanges: DebateCrossExamView[];
  execution: Execution;
  messageId: string;
  sceneKey: string;
  layoutMode?: DebateArenaLayout;
}) {
  const useSplit = layoutMode === "split";

  return (
    <div className="space-y-3">
      <ModeratorCrossExamCue />
      {useSplit ? (
        <SplitCrossExamColumns
          exchanges={exchanges}
          execution={execution}
          messageId={messageId}
          sceneKey={sceneKey}
        />
      ) : (
        exchanges.map((cx) => (
          <CrossExamSideBlock
            key={cx.targetKey}
            cx={cx}
            execution={execution}
            messageId={messageId}
            sceneKey={sceneKey}
          />
        ))
      )}
    </div>
  );
}

/** 质询阶段子标题：环节标题，纯文字不套横带（法槌留给裁判小结）。 */
function ModeratorCrossExamCue() {
  return (
    <div className="mt-3 flex items-baseline gap-2 border-t border-border pt-3">
      <h4 className="shrink-0 text-xl font-semibold text-foreground">质询</h4>
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        主持人发出必答质询
      </span>
    </div>
  );
}

function SplitCrossExamColumns({
  exchanges,
  execution,
  messageId,
  sceneKey,
}: {
  exchanges: DebateCrossExamView[];
  execution: Execution;
  messageId: string;
  sceneKey: string;
}) {
  const pro = exchanges.find((cx) => cx.targetKey === "pro");
  const con = exchanges.find((cx) => cx.targetKey === "con");
  const others = exchanges.filter(
    (cx) => cx.targetKey !== "pro" && cx.targetKey !== "con",
  );

  return (
    <>
      <div className="grid grid-cols-2 items-start gap-4">
        <div className="min-w-0">
          {pro && (
            <CrossExamSideBlock
              cx={pro}
              execution={execution}
              messageId={messageId}
              sceneKey={sceneKey}
            />
          )}
        </div>
        <div className="min-w-0">
          {con && (
            <CrossExamSideBlock
              cx={con}
              execution={execution}
              messageId={messageId}
              sceneKey={sceneKey}
            />
          )}
        </div>
      </div>
      {others.map((cx) => (
        <CrossExamSideBlock
          key={cx.targetKey}
          cx={cx}
          execution={execution}
          messageId={messageId}
          sceneKey={sceneKey}
        />
      ))}
    </>
  );
}

function CrossExamSideBlock({
  cx,
  execution,
  messageId,
  sceneKey,
}: {
  cx: DebateCrossExamView;
  execution: Execution;
  messageId: string;
  sceneKey: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const run = cx.answerRun;
  const agent = run
    ? execution.agents.find((a) => a.id === run.agentId)
    : undefined;
  const fullOutput = agent ? agent.outputChunks.join("") : "";
  const streaming = run?.status === "running";
  const total = cx.exchanges.length;
  const answered = cx.exchanges.filter((ex) => ex.ok).length;

  // 「展开全文」与立论区 ArgumentSpeech 的 showAll 同语义：就地全文视图，持久化记住。
  const [showAll, setShowAll] = usePersistentDisclosure(
    `${sceneKey}:${cx.targetKey}:all`,
    false,
  );
  const canExpand = fullOutput.trim().length > 0;

  const openRunDetail = () => {
    if (!run) return;
    showRunDetail(messageId, run.id, `${cx.targetName} · 质询作答`);
  };

  const meta = (
    <>
      <span className="font-medium" style={{ color: cx.targetColorVar }}>
        {cx.targetName}
      </span>
      <span className="text-muted-foreground">
        {total === 0 ? "暂无质询问答" : `· ${answered}/${total} 正面回答`}
      </span>
    </>
  );

  return (
    <div
      className="border-l-[3px] pl-3"
      style={{ borderLeftColor: cx.targetColorVar }}
    >
      <div className="mb-1 flex items-center gap-2 text-xs">
        {run ? (
          // 对齐 SpeakerBlock：点名字行打开该方作答 run 的详情侧栏。
          <Button
            variant="ghost"
            onClick={openRunDetail}
            className="h-auto justify-start gap-2 rounded-none px-0 py-0 text-xs hover:bg-transparent"
          >
            {meta}
          </Button>
        ) : (
          <span className="flex items-center gap-2">{meta}</span>
        )}
        {canExpand && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className="ml-auto shrink-0 text-xs font-medium text-primary hover:underline"
          >
            {showAll ? "收起全文" : "展开全文"}
          </button>
        )}
      </div>
      {showAll && canExpand ? (
        <div className="pb-2 text-sm text-foreground">
          {streaming ? (
            <p className="whitespace-pre-wrap break-words">
              {fullOutput}
              <span
                className="ml-0.5 inline-block h-[1em] w-px animate-pulse bg-primary align-text-bottom"
                aria-hidden
              />
            </p>
          ) : (
            <>
              {/* 用户显式「展开全文」= 要看完整内容，不再套 CollapsibleSpeech。 */}
              <Markdown content={fullOutput} evidence />
              <button
                type="button"
                onClick={() => setShowAll(false)}
                className="mt-1 text-xs font-medium text-primary hover:underline"
              >
                收起全文
              </button>
            </>
          )}
        </div>
      ) : total > 0 ? (
        <ul className="divide-y divide-border/40">
          {cx.exchanges.map((ex, i) => (
            <CrossExamQaRow
              key={`${cx.targetKey}:${i}`}
              exchange={ex}
              index={i}
              streaming={streaming && i === cx.exchanges.length - 1}
              sceneKey={`${sceneKey}:qa:${cx.targetKey}:${i}`}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CrossExamQaRow({
  exchange,
  index,
  streaming,
  sceneKey,
}: {
  exchange: DebateCrossExamExchangeView;
  index: number;
  streaming: boolean;
  sceneKey: string;
}) {
  const hasAnswer = exchange.answer.trim().length > 0;
  const live = streaming && !hasAnswer;
  const [answerOpen, toggleAnswerOpen] = useStreamAwareDisclosure(
    `${sceneKey}:ans`,
    live,
  );
  const answerSummary = summarizeAnswer(exchange.answer);

  return (
    <li className="py-1.5">
      <div className="flex items-start gap-1.5 text-sm text-foreground">
        <span className="shrink-0 text-xs text-muted-foreground">
          Q{index + 1}.
        </span>
        <span className="min-w-0 flex-1 leading-snug">{exchange.question}</span>
        <QaStatus ok={exchange.ok} hasAnswer={hasAnswer} />
      </div>

      <div className="mt-1 border-t border-border/40 pt-1">
        <button
          type="button"
          onClick={toggleAnswerOpen}
          aria-expanded={answerOpen}
          className="flex w-full items-start gap-1.5 text-left text-xs hover:text-foreground"
        >
          {answerOpen ? (
            <ChevronDown
              size={12}
              className="mt-0.5 shrink-0 text-muted-foreground"
            />
          ) : (
            <ChevronRight
              size={12}
              className="mt-0.5 shrink-0 text-muted-foreground"
            />
          )}
          <CornerDownRight
            size={11}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
          {!answerOpen && hasAnswer && (
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {answerSummary}
            </span>
          )}
          {!answerOpen && !hasAnswer && (
            <span className="text-muted-foreground">
              {exchange.ok ? "等待作答…" : "未作答"}
            </span>
          )}
        </button>

        <div
          className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
          style={{
            gridTemplateRows: answerOpen ? "1fr" : "0fr",
            opacity: answerOpen ? 1 : 0,
          }}
        >
          <div className="overflow-hidden">
            <div className="px-2 pb-1 pt-1 text-sm">
              {streaming && hasAnswer ? (
                <p className="whitespace-pre-wrap break-words">
                  {exchange.answer}
                  <span className="ml-0.5 inline-block h-[1em] w-px animate-pulse bg-primary align-text-bottom" />
                </p>
              ) : hasAnswer ? (
                <CollapsibleSpeech
                  contentKey={exchange.answer}
                  sceneKey={`${sceneKey}:ans-body`}
                >
                  <Markdown content={exchange.answer} evidence />
                </CollapsibleSpeech>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {exchange.ok ? "等待作答…" : "未作答。"}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

function QaStatus({ ok, hasAnswer }: { ok: boolean; hasAnswer: boolean }) {
  if (ok && hasAnswer) {
    return <CheckCircle2 size={12} className="shrink-0 text-success" />;
  }
  if (!hasAnswer && ok) {
    return (
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />
    );
  }
  return <TriangleAlert size={12} className="shrink-0 text-muted-foreground" />;
}

function summarizeAnswer(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const firstSentence = trimmed.split(/[。；]/)[0]?.trim() || trimmed;
  return summarizeText(firstSentence, ANSWER_SUMMARY_LEN);
}
