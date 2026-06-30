import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui";
import {
  debateSignalDot,
  statusPillInline,
  surfaceSubtle,
  verdictTogglePill,
} from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { agentColorVar } from "@/lib/agentIdentity";
import type { Execution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import type { DebateSideInfo } from "@/types/events";
import { ChevronRight, Swords } from "lucide-react";
import { RoundInterjections } from "./Interjections";
import { SideIdentity } from "./SideChip";
import {
  type DebateRoundModel,
  type DebateSideModel,
  roundSignal,
  toDebateModel,
} from "./model";

/**
 * 对比擂台透镜（放大态可选视图·前端UX设计.md §4.1/§4.1b）—— 把正反 2 方收场复盘成**左右对开擂台**
 * （= Chatbot Arena Battle 用法），逐轮较真比对：正方一列 / 反方一列、中缝认知推进脊 + 贯通交锋点带。
 * 多方圆桌 / 红队不适用（无左右两列可对齐），不出此透镜。读同一个 {@link toDebateModel}（零新数据）；
 * 进行中（roster 未到）给占位，收场后呈擂台。统一辩论室主视图见 {@link import("./DebateStream").DebateStream}。
 */
export function DebateArena({
  execution,
  messageId,
}: {
  execution: Execution;
  messageId: string;
}) {
  const model = toDebateModel(execution);
  if (!model) return null;
  const sides = model.sides;
  // 擂台仅正反 2 方对开，且需收场 roster（含立场）才能起列头；其余形态 / 进行中给占位。
  if (
    !model.settled ||
    !sides ||
    sides.length !== 2 ||
    model.form !== "debate"
  ) {
    return <ArenaPlaceholder settled={model.settled} />;
  }
  return (
    <Arena
      rounds={model.rounds}
      execution={execution}
      messageId={messageId}
      sides={sides}
    />
  );
}

/** 擂台不可用时的占位：进行中 → 收场后可对比；非正反 2 方 → 引去群聊。 */
function ArenaPlaceholder({ settled }: { settled: boolean }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-12 text-center">
      <Swords size={20} className="text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {settled
          ? "对比擂台仅适用正反两方辩论——本场请用「群聊」查看。"
          : "辩论进行中——收场后可在此左右对比正反两方。"}
      </p>
    </div>
  );
}

/**
 * 擂台·左右对齐（正反 2 方收场复盘，concept-2-arena）：正方一列 / 反方一列，中缝是一条「认知推进
 * 脊」——每轮一个轴点（信号色）+ 焦点 + 裁判 pill，把逐轮交锋铺成可逐条较真比对的两列。每轮发言下挂
 * 一条**贯通全宽**的交锋点带（谁驳谁·要点，按来源方身份色）。发言点头钻右坞完整产出（与叙事线同口径）。
 */
function Arena({
  rounds,
  execution,
  messageId,
  sides,
}: {
  rounds: DebateRoundModel[];
  execution: Execution;
  messageId: string;
  sides: DebateSideInfo[];
}) {
  // roster 里 pro / con 两方（驱动列头 + 每轮按 stance 取本列发言）。
  const proInfo = sides.find((s) => s.stance === "pro") ?? sides[0];
  const conInfo = sides.find((s) => s.stance === "con") ?? sides[1];

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2">
        <ColumnHead info={proInfo} align="left" />
        <div className="flex items-center justify-center">
          <span className="rounded-full border border-border bg-muted px-2 py-1 text-xs font-bold text-muted-foreground">
            VS
          </span>
        </div>
        <ColumnHead info={conInfo} align="right" />
      </div>

      {rounds.map((round) => {
        const pro = round.sides.find((s) => s.stance === "pro") ?? null;
        const con = round.sides.find((s) => s.stance === "con") ?? null;
        return (
          <div key={round.roundNo} className="space-y-1.5">
            <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
              <SpeechCell
                side={pro}
                align="left"
                execution={execution}
                messageId={messageId}
              />
              <RoundSpine round={round} />
              <SpeechCell
                side={con}
                align="right"
                execution={execution}
                messageId={messageId}
              />
            </div>
            {round.clashes.length > 0 && (
              <div
                className={`rounded-lg border p-2.5 ${surfaceSubtle.primary}`}
              >
                <h5 className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Swords size={12} />
                  本轮交锋点
                </h5>
                <ul className="space-y-1">
                  {round.clashes.map((c, i) => (
                    <li
                      key={`${c.fromKey}-${c.toKey}-${i}`}
                      className="flex flex-wrap items-baseline gap-x-1.5 text-sm"
                    >
                      <span
                        className="shrink-0 text-xs font-medium"
                        style={{ color: c.fromColorVar }}
                      >
                        {c.fromName}
                      </span>
                      <ChevronRight
                        size={12}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span
                        className="shrink-0 text-xs font-medium"
                        style={{ color: c.toColorVar }}
                      >
                        {c.toName}
                      </span>
                      <span className="min-w-0 flex-1 text-foreground">
                        {c.point}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <RoundInterjections
              interjections={round.userInterjections}
              sides={round.sides}
            />
          </div>
        );
      })}
    </div>
  );
}

/** 列头：一方身份（名 + 模型徽章 + 立场）+ 最强论点速览，正方左对齐 / 反方右对齐。 */
function ColumnHead({
  info,
  align,
}: {
  info: DebateSideInfo | undefined;
  align: "left" | "right";
}) {
  if (!info) return <div />;
  const colorVar = agentColorVar(info.name);
  return (
    <div
      className="rounded-lg border border-border bg-card p-2.5"
      style={{ borderTopColor: colorVar, borderTopWidth: 2 }}
    >
      <div
        className={`flex items-center gap-1.5 ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        <SideIdentity name={info.name} colorVar={colorVar} model={info.model} />
      </div>
    </div>
  );
}

/** 中缝脊：本轮轴点（信号色）+ 焦点 + 裁判（有交锋 / 收敛）pill。 */
function RoundSpine({ round }: { round: DebateRoundModel }) {
  const v = round.verdict;
  return (
    <div className="flex w-20 flex-col items-center gap-1 rounded-lg bg-muted/40 px-1.5 py-2 text-center sm:w-24">
      <span
        className={`flex size-6 items-center justify-center rounded-full text-xs font-bold text-background ${debateSignalDot[roundSignal(round)]}`}
      >
        {round.roundNo >= 1 ? round.roundNo : ""}
      </span>
      {round.focus && (
        <span className="line-clamp-2 text-xs font-medium leading-tight text-foreground">
          {round.focus}
        </span>
      )}
      {v && (
        <div className="flex flex-wrap justify-center gap-1">
          <span className={verdictTogglePill(v.real_clash)}>
            {v.real_clash ? "有交锋" : "各说各话"}
          </span>
          {v.converged && (
            <span className={statusPillInline.success}>已收敛</span>
          )}
        </div>
      )}
    </div>
  );
}

/** 一方在一轮的发言格：身份头（点钻右坞完整产出）+ 渲染后发言 markdown。正方左缘着色 / 反方右缘着色。 */
function SpeechCell({
  side,
  align,
  execution,
  messageId,
}: {
  side: DebateSideModel | null;
  align: "left" | "right";
  execution: Execution;
  messageId: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  if (!side) {
    return (
      <div className="grid place-items-center rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        本轮未发言
      </div>
    );
  }
  const run = side.run;
  const agent = run
    ? execution.agents.find((a) => a.id === run.agentId)
    : undefined;
  const output = agent ? agent.outputChunks.join("") : "";
  const edge =
    align === "left"
      ? { borderLeftColor: side.colorVar, borderLeftWidth: 2 }
      : { borderRightColor: side.colorVar, borderRightWidth: 2 };

  const header = (
    <span className="flex w-full items-center gap-1.5 text-left">
      <SideIdentity
        name={side.name}
        colorVar={side.colorVar}
        model={side.model}
      />
      <span className="min-w-0 flex-1" />
      {run && (
        <ChevronRight size={13} className="shrink-0 text-muted-foreground/50" />
      )}
    </span>
  );

  return (
    <div
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-card"
      style={edge}
    >
      {run ? (
        <SimpleTooltip label="查看完整产出">
          <Button
            variant="ghost"
            onClick={() => showRunDetail(messageId, run.id, side.name)}
            className="h-auto w-full justify-start gap-1.5 rounded-none border-b border-border px-3 py-2 hover:bg-transparent"
          >
            {header}
          </Button>
        </SimpleTooltip>
      ) : (
        <div className="border-b border-border px-3 py-2">{header}</div>
      )}
      <div className="p-3">
        {output ? (
          <div className="max-h-80 overflow-y-auto text-sm">
            <Markdown content={output} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">（暂无输出）</p>
        )}
      </div>
    </div>
  );
}
