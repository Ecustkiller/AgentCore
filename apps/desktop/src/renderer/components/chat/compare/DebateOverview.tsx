import { Markdown } from "@/components/chat/Markdown";
import { BriefCard } from "@/components/chat/debate/Brief";
import { CollapsibleSpeech } from "@/components/chat/debate/CollapsibleSpeech";
import { ModeratorAvatar } from "@/components/chat/debate/DebateStream";
import { RoundInterjections } from "@/components/chat/debate/Interjections";
import { ModelBadge } from "@/components/chat/debate/ModelBadge";
import { SideIdentity } from "@/components/chat/debate/SideChip";
import {
  type DebateForm,
  type DebateModel,
  type DebateRoundModel,
  type DebateSideModel,
  debateFormBlurb,
  describeRoundVerdict,
  roundSignal,
} from "@/components/chat/debate/model";
import { Button } from "@/components/ui";
import {
  debateSignalDot,
  debateSignalText,
} from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { agentColorVar } from "@/lib/agentIdentity";
import type { Execution } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import type { DebateSideInfo } from "@/types/events";
import { ChevronRight, Info, Swords } from "lucide-react";

/**
 * 辩论形态的纵览层（对比擂台矩阵，前端UX设计.md §4.1/§4.1b）——把正反 2 方收场复盘成**左右对开
 * 擂台**（= Chatbot Arena Battle 用法）逐轮较真比对：正方一列 / 反方一列、中缝认知推进脊 + 贯通
 * 交锋点带。对比模式下每格发言可 pick 成 A/B 喂给共享的 {@link import("./ComparePane").ComparePane}
 * （可跨轮 / 跨方，甚至对某方 round3 × round5 看论证怎么演进）。多方圆桌 / 红队不适用（无左右两列
 * 可对齐）——此形态只用于正反 2 方，其余走版本轨（{@link import("./RevisionOverview").RevisionOverview}）。
 * 读同一个 {@link DebateModel}（零新数据）。统一辩论室主视图见 {@link import("../debate/DebateStream").DebateStream}。
 */
export function DebateOverview({
  model,
  execution,
  messageId,
  compareMode,
  pair,
  onPick,
}: {
  model: DebateModel;
  execution: Execution;
  messageId: string;
  compareMode: boolean;
  /** 当前 A/B 选中的两个 `run.id`（display order：A 在前）。 */
  pair: [string, string];
  onPick: (runId: string) => void;
}) {
  const sides = model.sides;
  if (!sides) return null;
  // roster 里 pro / con 两方（驱动列头 + 每轮按 stance 取本列发言）。
  const proInfo = sides.find((s) => s.stance === "pro") ?? sides[0];
  const conInfo = sides.find((s) => s.stance === "con") ?? sides[1];

  return (
    <div className="space-y-2">
      {/* 「这是什么」收进 info 提示（不再常驻长句）：擂台首次用户悬浮即可读到这场辩论给他什么。 */}
      <div className="flex justify-end">
        <SimpleTooltip label={debateFormBlurb(model.form)}>
          <span
            className="inline-flex cursor-help items-center gap-1 text-xs text-muted-foreground"
            aria-label="这场辩论是什么"
          >
            <Info size={12} />
            这是什么
          </span>
        </SimpleTooltip>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2">
        <ColumnHead info={proInfo} align="left" />
        <div className="flex items-center justify-center">
          <span className="rounded-full border border-border bg-muted px-2 py-1 text-xs font-bold text-muted-foreground">
            VS
          </span>
        </div>
        <ColumnHead info={conInfo} align="right" />
      </div>

      {model.rounds.map((round) => {
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
                compareMode={compareMode}
                pair={pair}
                onPick={onPick}
              />
              <RoundSpine round={round} form={model.form} />
              <SpeechCell
                side={con}
                align="right"
                execution={execution}
                messageId={messageId}
                compareMode={compareMode}
                pair={pair}
                onPick={onPick}
              />
            </div>
            {round.clashes.length > 0 && (
              <div className="border-l-2 border-border pl-2.5">
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

/** 擂台的收尾结论面（主持人终审）——与群聊主视图 FinalVerdict 同构：法槌头像 + 满宽中性气泡 +
 *  展平简报（{@link BriefCard}），并可钻「裁决过程」。简报未就绪（理论上收场即有）则不渲染。 */
export function DebateVerdict({
  model,
  execution,
  messageId,
}: {
  model: DebateModel;
  execution: Execution;
  messageId: string;
}) {
  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const brief = model.brief;
  const sides = model.sides;
  if (!brief || !sides) return null;
  const moderatorRun = model.moderatorRunId
    ? execution.runs.find((r) => r.id === model.moderatorRunId)
    : undefined;
  return (
    <div className="flex justify-start">
      <div className="flex w-full gap-2">
        <ModeratorAvatar model={moderatorRun?.model} />
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-muted/40 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">
              主持人终审
            </span>
            <ModelBadge model={moderatorRun?.model ?? ""} />
            <span className="min-w-0 flex-1" />
            {moderatorRun && (
              <Button
                variant="ghost"
                onClick={() =>
                  showRunDetail(messageId, moderatorRun.id, "主持人")
                }
                className="h-auto px-0 py-0 text-xs text-primary hover:bg-transparent"
              >
                裁决过程
              </Button>
            )}
          </div>
          <BriefCard brief={brief} sides={sides} form={model.form} />
        </div>
      </div>
    </div>
  );
}

/** 擂台不可用时的占位：进行中 → 收场后可对比；非正反 2 方 → 引去群聊。 */
export function ArenaPlaceholder({ settled }: { settled: boolean }) {
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

/** 中缝脊：本轮轴点（信号色）+ 焦点 + 一句「人话」轮状态（{@link describeRoundVerdict}，信号色）。 */
function RoundSpine({
  round,
  form,
}: {
  round: DebateRoundModel;
  form: DebateForm;
}) {
  const v = round.verdict;
  const status = v ? describeRoundVerdict(v, form) : null;
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
      {status && (
        <SimpleTooltip label={status.hint}>
          <span
            className={`text-xs font-medium leading-tight ${debateSignalText[roundSignal(round)]}`}
          >
            {status.label}
          </span>
        </SimpleTooltip>
      )}
    </div>
  );
}

/** 一方在一轮的发言格：身份头 + 渲染后发言 markdown。正方左缘着色 / 反方右缘着色。聚焦模式点头钻
 * 右坞完整产出；对比模式点头把本格 pick 成 A/B（选中加环 + 徽章）——共享精读对比面据此并排细读。 */
function SpeechCell({
  side,
  align,
  execution,
  messageId,
  compareMode,
  pair,
  onPick,
}: {
  side: DebateSideModel | null;
  align: "left" | "right";
  execution: Execution;
  messageId: string;
  compareMode: boolean;
  pair: [string, string];
  onPick: (runId: string) => void;
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
  const badge =
    run && run.id === pair[0] ? "A" : run && run.id === pair[1] ? "B" : null;
  const picked = compareMode && badge != null;
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
      {compareMode && badge && (
        <span className="rounded bg-primary px-1 text-xs font-semibold text-primary-foreground">
          {badge}
        </span>
      )}
      {run && !compareMode && (
        <ChevronRight size={13} className="shrink-0 text-muted-foreground/50" />
      )}
    </span>
  );

  return (
    <div
      className={`min-w-0 overflow-hidden rounded-lg border bg-card ${
        picked ? "border-primary ring-1 ring-primary" : "border-border"
      }`}
      style={edge}
    >
      {run ? (
        <SimpleTooltip label={compareMode ? "选为对比 A / B" : "查看完整产出"}>
          <Button
            variant="ghost"
            onClick={() =>
              compareMode
                ? onPick(run.id)
                : showRunDetail(messageId, run.id, side.name)
            }
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
          <CollapsibleSpeech contentKey={output}>
            <Markdown content={output} />
          </CollapsibleSpeech>
        ) : (
          <p className="text-xs text-muted-foreground">（暂无输出）</p>
        )}
      </div>
    </div>
  );
}
