import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui";
import { statusAccentText } from "@/components/ui/tone-presets";
import { useStreamAwareDisclosure } from "@/stores/disclosure";
import type { Execution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  MessageCircleQuestion,
  TriangleAlert,
} from "lucide-react";
import { CollapsibleSpeech } from "../CollapsibleSpeech";
import { SideNamePill } from "../SideChip";
import type { DebateCrossExamView } from "../model";
import { ModeratorAvatar } from "./Moderator";

/**
 * 质询环节（质询回合 P1）—— 主持人代表交锋、当面向各方发出【必须正面回答】的质询，被质询方在自己
 * transcript 上接招 / 回避。渲染为嵌在本轮里的一张「质询卡」（法槌头像标明主持人主导，与主流发言气泡
 * 拉开层次）：每条交换 = 主持人的必答问题清单（Q1/Q2…）+ 该方作答（`answerRun` 解析全文、可钻取完整
 * 产出），回避 / 未答出标注「未正面回答」。让「交锋当面发生、回避被看见」在群聊里可读，而非埋进辩手
 * 长文里靠用户脑补。**默认折叠**（渐进披露·收回合级密度）：收起态卡头显「N 组问答 · M 处未正面回答」
 * 把「谁回避」前置，展开看 Q→A；直播态（有作答在流）首挂自动展开、可手动收起。纯渲染。
 */
export function CrossExamBlock({
  exchanges,
  execution,
  messageId,
  moderatorModel,
  sceneKey,
}: {
  exchanges: DebateCrossExamView[];
  execution: Execution;
  messageId: string;
  moderatorModel: string;
  sceneKey?: string;
}) {
  const evaded = exchanges.filter((cx) => !cx.ok).length;
  const live = exchanges.some((cx) => cx.answerRun?.status === "running");
  const [open, toggleOpen] = useStreamAwareDisclosure(sceneKey ?? null, live);
  return (
    <div className="flex justify-start">
      <div className="flex w-full max-w-[92%] gap-2">
        <ModeratorAvatar model={moderatorModel} />
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-muted/30">
          <button
            type="button"
            onClick={toggleOpen}
            aria-expanded={open}
            className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-muted/50 ${
              open ? "border-b border-border/60" : ""
            }`}
          >
            {open ? (
              <ChevronDown
                size={13}
                className="shrink-0 text-muted-foreground"
              />
            ) : (
              <ChevronRight
                size={13}
                className="shrink-0 text-muted-foreground"
              />
            )}
            <MessageCircleQuestion
              size={13}
              className={statusAccentText.primary}
            />
            <span className="text-xs font-medium text-foreground">
              质询环节
            </span>
            <span className="text-xs text-muted-foreground">
              · {exchanges.length} 组问答
            </span>
            {evaded > 0 && (
              <span className="inline-flex items-center gap-0.5 text-xs text-destructive">
                <TriangleAlert size={11} />
                {evaded} 处未正面回答
              </span>
            )}
            <span className="min-w-0 flex-1" />
            <span className="shrink-0 text-xs text-muted-foreground">
              {open ? "收起" : "展开"}
            </span>
          </button>
          {open && (
            <div className="space-y-2.5 px-3 py-2">
              {exchanges.map((cx) => (
                <CrossExamExchangeRow
                  key={cx.targetKey}
                  cx={cx}
                  execution={execution}
                  messageId={messageId}
                  answerKeyBase={sceneKey}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 一条质询问答：主持人对某方的必答问题清单 + 该方作答（身份色引用块 · 全文可钻取 · 回避标注）。 */
function CrossExamExchangeRow({
  cx,
  execution,
  messageId,
  answerKeyBase,
}: {
  cx: DebateCrossExamView;
  execution: Execution;
  messageId: string;
  answerKeyBase?: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const run = cx.answerRun;
  const agent = run
    ? execution.agents.find((a) => a.id === run.agentId)
    : undefined;
  const answer = agent ? agent.outputChunks.join("") : "";
  const streaming = run?.status === "running";
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">质询</span>
        <SideNamePill name={cx.targetName} colorVar={cx.targetColorVar} />
      </div>
      <ul className="mt-1 space-y-0.5">
        {cx.questions.map((q, i) => (
          <li key={q} className="flex gap-1.5 text-sm text-foreground">
            <span className="shrink-0 text-muted-foreground">Q{i + 1}.</span>
            <span className="min-w-0 flex-1">{q}</span>
          </li>
        ))}
      </ul>
      <div
        className="mt-1.5 rounded-lg border-l-2 bg-card px-2.5 py-1.5"
        style={{ borderLeftColor: cx.targetColorVar }}
      >
        <div className="flex items-center gap-1.5">
          <CornerDownRight
            size={12}
            className="shrink-0 text-muted-foreground"
          />
          <span
            className="text-xs font-medium"
            style={{ color: cx.targetColorVar }}
          >
            {cx.targetName} 作答
          </span>
          {!cx.ok && (
            <span className="inline-flex items-center gap-0.5 text-xs text-destructive">
              <TriangleAlert size={11} />
              未正面回答
            </span>
          )}
          <span className="min-w-0 flex-1" />
          {run && answer && (
            <Button
              variant="ghost"
              onClick={() =>
                showRunDetail(messageId, run.id, `${cx.targetName} · 质询作答`)
              }
              className="h-auto px-0 py-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
            >
              查看
            </Button>
          )}
        </div>
        <div className="mt-0.5">
          {streaming ? (
            <p className="whitespace-pre-wrap break-words text-sm text-foreground">
              {answer}
              <span
                className="ml-0.5 inline-block h-[1em] w-px animate-pulse align-text-bottom"
                style={{ backgroundColor: cx.targetColorVar }}
                aria-hidden
              />
            </p>
          ) : answer ? (
            <CollapsibleSpeech
              contentKey={answer}
              sceneKey={
                answerKeyBase
                  ? `${answerKeyBase}:ans:${cx.targetKey}`
                  : undefined
              }
            >
              <Markdown content={answer} evidence />
            </CollapsibleSpeech>
          ) : (
            <p className="text-xs text-muted-foreground">
              {cx.ok ? "等待作答…" : "未作答。"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
