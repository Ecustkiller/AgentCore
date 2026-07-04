import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui";
import { statusAccentText } from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { Execution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { Info, Megaphone, TriangleAlert } from "lucide-react";
import { CollapsibleSpeech } from "../CollapsibleSpeech";
import { SideNamePill } from "../SideChip";
import type { DebateClosingView } from "../model";

/**
 * 结辩陈词区（阶段化发言角色 P4 · 结辩收束）—— 辩已辩尽后、主持人终审前，各方最后亮胜负手（真人辩论
 * 的收尾环节）。渲染为一段带「结辩陈词」分割线的区块 + 各方结辩气泡（{@link ClosingRow}）：这一层是
 * 辩手自己的 advocacy 收束（身份色气泡、可钻取全文），与其后主持人中立的终审（{@link FinalVerdict}）
 * 正交并存——读者先看各方「最后的话」，再看裁判怎么判。仅收场且开启了结辩（认真辩透 + 对抗形态）才出。
 * 纯渲染。
 */
export function ClosingSection({
  closings,
  execution,
  messageId,
}: {
  closings: DebateClosingView[];
  execution: Execution;
  messageId: string;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 py-1">
        <span className="h-px flex-1 bg-border" />
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Megaphone size={13} className={statusAccentText.primary} />
          <span className="font-medium text-foreground">结辩陈词</span>
          <SimpleTooltip label="辩已辩尽，各方做最后陈词——只讲胜负手（本方最强论点 + 为何对方反驳不成立），不引入新论据。这是辩手自己的收束，主持人的中立裁决在下方终审。">
            <span
              className="inline-flex shrink-0 cursor-help text-muted-foreground"
              aria-label="什么是结辩陈词"
            >
              <Info size={12} />
            </span>
          </SimpleTooltip>
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
      {closings.map((c) => (
        <ClosingRow
          key={c.sideKey}
          closing={c}
          execution={execution}
          messageId={messageId}
        />
      ))}
    </div>
  );
}

/** 一方的结辩气泡（靠左·与逐轮发言 {@link SpeechBubble} 同族的身份色气泡，头带「结辩」标）。 */
function ClosingRow({
  closing,
  execution,
  messageId,
}: {
  closing: DebateClosingView;
  execution: Execution;
  messageId: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const run = closing.run;
  const agent = run
    ? execution.agents.find((a) => a.id === run.agentId)
    : undefined;
  const text = agent ? agent.outputChunks.join("") : "";
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[85%] gap-2">
        <span
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
          style={{
            color: closing.colorVar,
            backgroundColor: `color-mix(in oklch, ${closing.colorVar} 16%, transparent)`,
          }}
          aria-hidden
        >
          {closing.name.slice(0, 1)}
        </span>
        <div
          className="min-w-0 overflow-hidden rounded-xl border border-t-2 border-border bg-card"
          style={{ borderTopColor: closing.colorVar }}
        >
          <div
            className="flex items-center gap-1.5 px-3 pb-1 pt-2"
            style={{
              background: `linear-gradient(to bottom, color-mix(in oklch, ${closing.colorVar} 9%, var(--card)), var(--card))`,
            }}
          >
            <SideNamePill name={closing.name} colorVar={closing.colorVar} />
            <span
              className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
              title="结辩陈词"
            >
              <Megaphone size={11} />
              结辩
            </span>
            {!closing.ok && (
              <span className="inline-flex items-center gap-0.5 text-xs text-destructive">
                <TriangleAlert size={11} />
                未产出结辩
              </span>
            )}
            <span className="min-w-0 flex-1" />
            {run && text && (
              <Button
                variant="ghost"
                onClick={() =>
                  showRunDetail(messageId, run.id, `${closing.name} · 结辩`)
                }
                className="h-auto px-0 py-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
              >
                查看
              </Button>
            )}
          </div>
          <div className="px-3 pb-2.5 pt-1">
            {text ? (
              <CollapsibleSpeech
                contentKey={text}
                sceneKey={`${messageId}:dclose:${closing.sideKey}`}
              >
                <Markdown content={text} evidence />
              </CollapsibleSpeech>
            ) : (
              <p className="text-xs text-muted-foreground">
                {closing.ok ? "等待结辩…" : "未产出结辩。"}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
