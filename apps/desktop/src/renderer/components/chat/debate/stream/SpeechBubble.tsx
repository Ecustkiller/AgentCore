import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui";
import { statusAccentText } from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { Execution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { CornerDownRight } from "lucide-react";
import { CollapsibleSpeech } from "../CollapsibleSpeech";
import { SideNamePill } from "../SideChip";
import type {
  DebateClashView,
  DebateRoundModel,
  DebateSideModel,
} from "../model";
import { StanceVote } from "./AskBubble";
import { speechPlaceholder } from "./speechPlaceholder";

/** L3 交锋 = 引用回复：在反驳方气泡顶部引一句「回 X：要点」，按被驳方身份色着色。 */
export function ReplyQuote({ clash }: { clash: DebateClashView }) {
  return (
    <div
      className="mx-3 mt-1.5 flex items-start gap-1 rounded-lg border-l-2 bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
      style={{ borderLeftColor: clash.toColorVar }}
    >
      <CornerDownRight size={12} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="font-medium" style={{ color: clash.toColorVar }}>
          回 {clash.toName}
        </span>
        ：{clash.point}
      </span>
    </div>
  );
}

/** 一方的发言气泡（观察者群聊：辩手一律靠左）：身份头像 + 头（点钻右坞完整产出）+ 引用回复（本方
 * 反驳了谁的哪句）+ 正文。流式中渲染纯文本 + 闪烁光标，完成后渲染 markdown。 */
export function SpeechBubble({
  side,
  round,
  execution,
  messageId,
  showStance,
  column = false,
  align = "left",
}: {
  side: DebateSideModel;
  round: DebateRoundModel;
  execution: Execution;
  messageId: string;
  showStance: boolean;
  column?: boolean;
  align?: "left" | "right";
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const run = side.run;
  const agent = run
    ? execution.agents.find((a) => a.id === run.agentId)
    : undefined;
  const output = agent ? agent.outputChunks.join("") : "";
  const streaming = run?.status === "running";
  const replies =
    round.roundNo >= 2
      ? round.clashes.filter((c) => c.fromKey === side.sideKey)
      : [];

  const status = streaming ? (
    <output
      aria-live="polite"
      className={`ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium ${statusAccentText.primary}`}
    >
      <span className="size-1.5 animate-pulse rounded-full bg-current" />
      正在输入…
    </output>
  ) : run?.status === "failed" ? (
    <span className="ml-auto shrink-0 text-xs text-destructive">发言失败</span>
  ) : null;

  const header = (
    <span className="flex w-full items-center gap-1.5 text-left">
      <SideNamePill name={side.name} colorVar={side.colorVar} />
      {status}
    </span>
  );

  const right = column && align === "right";
  return (
    <div className={column ? "flex" : "flex justify-start"}>
      <div
        className={`flex gap-2 ${
          column ? `w-full ${right ? "flex-row-reverse" : ""}` : "max-w-[85%]"
        }`}
      >
        <span
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
          style={{
            color: side.colorVar,
            backgroundColor: `color-mix(in oklch, ${side.colorVar} 16%, transparent)`,
          }}
          aria-hidden
        >
          {side.name.slice(0, 1)}
        </span>
        <div
          className={`min-w-0 overflow-hidden rounded-xl border border-t-2 border-border bg-card${
            column ? " flex-1" : ""
          }`}
          style={{ borderTopColor: side.colorVar }}
        >
          {run ? (
            <SimpleTooltip label="查看完整产出">
              <Button
                variant="ghost"
                onClick={() => showRunDetail(messageId, run.id, side.name)}
                className="h-auto w-full justify-start gap-1.5 rounded-none px-3 pb-1 pt-2 hover:brightness-95"
                style={{
                  background: `linear-gradient(to bottom, color-mix(in oklch, ${side.colorVar} 9%, var(--card)), var(--card))`,
                }}
              >
                {header}
              </Button>
            </SimpleTooltip>
          ) : (
            <div
              className="px-3 pb-1 pt-2"
              style={{
                background: `linear-gradient(to bottom, color-mix(in oklch, ${side.colorVar} 9%, var(--card)), var(--card))`,
              }}
            >
              {header}
            </div>
          )}
          {replies.map((c, i) => (
            <ReplyQuote key={`${c.toKey}-${i}`} clash={c} />
          ))}
          <div className={`px-3 pt-1 ${showStance ? "pb-1.5" : "pb-2.5"}`}>
            {streaming ? (
              <div className="whitespace-pre-wrap break-words text-sm text-foreground">
                {output}
                <span
                  className="ml-0.5 inline-block h-[1em] w-px animate-pulse align-text-bottom"
                  style={{ backgroundColor: side.colorVar }}
                  aria-hidden
                />
              </div>
            ) : output ? (
              <CollapsibleSpeech
                contentKey={output}
                sceneKey={`${messageId}:dspeech:r${round.roundNo}:${side.sideKey || side.key}`}
              >
                <Markdown content={output} evidence />
              </CollapsibleSpeech>
            ) : (
              <p className="text-xs text-muted-foreground">
                {speechPlaceholder(run)}
              </p>
            )}
          </div>
          {showStance && side.sideKey && (
            <div className="flex px-3 pb-2">
              <StanceVote
                turnId={messageId}
                sideKey={side.sideKey}
                name={side.name}
                colorVar={side.colorVar}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
