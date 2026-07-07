import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui";
import { useStreamAwareDisclosure } from "@/stores/disclosure";
import { useSidePanelStore } from "@/stores/sidePanel";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  MessageCircleQuestion,
  TriangleAlert,
} from "lucide-react";
import { CollapsibleSpeech } from "../CollapsibleSpeech";
import type {
  DebateCrossExamExchangeView,
  DebateCrossExamView,
} from "../model";
import { summarizeText } from "./parseSpeechArguments";

const ANSWER_SUMMARY_LEN = 30;

/** 质询小节：问题完整展示，回答默认折叠为一行摘要。 */
export function CrossExamSection({
  exchanges,
  messageId,
  sceneKey,
}: {
  exchanges: DebateCrossExamView[];
  messageId: string;
  sceneKey: string;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <MessageCircleQuestion size={13} />
        {exchanges.map((cx) => (
          <CrossExamOverview key={cx.targetKey} cx={cx} />
        ))}
      </div>
      {exchanges.map((cx) => (
        <CrossExamSideBlock
          key={cx.targetKey}
          cx={cx}
          messageId={messageId}
          sceneKey={sceneKey}
        />
      ))}
    </div>
  );
}

function CrossExamOverview({ cx }: { cx: DebateCrossExamView }) {
  const total = cx.exchanges.length;
  const answered = cx.exchanges.filter((ex) => ex.ok).length;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-medium" style={{ color: cx.targetColorVar }}>
        {cx.targetName}
      </span>
      <span>
        {answered}/{total} 正面回答
      </span>
      <span className="inline-flex gap-0.5">
        {cx.exchanges.map((ex, i) => (
          <span
            key={`${cx.targetKey}-dot-${i}`}
            className={`size-1.5 rounded-full ${dotClass(ex)}`}
            title={ex.ok && ex.answer.trim() ? "已正面回答" : "未正面回答"}
          />
        ))}
      </span>
    </span>
  );
}

function dotClass(ex: DebateCrossExamExchangeView): string {
  if (ex.ok && ex.answer.trim()) return "bg-success";
  if (!ex.answer.trim() && ex.ok) return "bg-primary animate-pulse";
  return "bg-muted-foreground";
}

function CrossExamSideBlock({
  cx,
  messageId,
  sceneKey,
}: {
  cx: DebateCrossExamView;
  messageId: string;
  sceneKey: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const run = cx.answerRun;
  const streaming = run?.status === "running";

  return (
    <div
      className="border-l-[3px] pl-3"
      style={{ borderLeftColor: cx.targetColorVar }}
    >
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span
          className="font-medium text-foreground"
          style={{ color: cx.targetColorVar }}
        >
          {cx.targetName}
        </span>
        <span className="text-muted-foreground">· 答问</span>
        {run && (
          <Button
            variant="ghost"
            onClick={() =>
              showRunDetail(messageId, run.id, `${cx.targetName} · 质询作答`)
            }
            className="ml-auto h-auto px-0 py-0 text-xs text-primary hover:bg-transparent"
          >
            查看产出
          </Button>
        )}
      </div>
      <ul className="space-y-1.5">
        {cx.exchanges.map((ex, i) => (
          <CrossExamQaRow
            key={`${cx.targetKey}:${i}`}
            exchange={ex}
            index={i}
            targetName={cx.targetName}
            streaming={streaming && i === cx.exchanges.length - 1}
            sceneKey={`${sceneKey}:qa:${cx.targetKey}:${i}`}
          />
        ))}
      </ul>
    </div>
  );
}

function CrossExamQaRow({
  exchange,
  index,
  targetName,
  streaming,
  sceneKey,
}: {
  exchange: DebateCrossExamExchangeView;
  index: number;
  targetName: string;
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
    <li className="rounded-lg bg-muted/20 px-2 py-1.5">
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
            <ChevronDown size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
          )}
          <CornerDownRight size={11} className="mt-0.5 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{targetName}</span>
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
