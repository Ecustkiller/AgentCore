import { countPillMuted, statusPillInline } from "@/components/ui/tone-presets";
import { useDebateTake, useDebateUserTake } from "@/stores/debateUserTake";
import type { DebateUserInterjection } from "@/types/events";
import { Hand, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { DebateSideModel } from "../model";

/** 用户追问气泡（右侧·第三方）的共用外形：用户头像 + 「你（追问）」+ 对象 pill + 原文 + 状态。
 *  收场权威复盘（{@link InterjectionBubble}）与裁判台掌舵段 live 乐观回显（{@link
 *  import("../DebateHud")} 的 PendingAskBubble）共用这一个外形，仅「对象文案 + 状态 pill」不同，避免
 *  两处近乎重复的气泡结构日久漂移。 */
export function AskBubble({
  ask,
  targetLabel,
  status,
}: {
  ask: string;
  targetLabel: string;
  status: ReactNode;
}) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] flex-row-reverse gap-2">
        <span
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          aria-hidden
        >
          <UserRound size={15} />
        </span>
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-muted/40">
          <div className="flex items-center gap-1.5 px-3 pb-1 pt-2">
            <span className="text-xs font-medium text-foreground">
              你（追问）
            </span>
            <span className={countPillMuted}>{targetLabel}</span>
          </div>
          <p className="px-3 text-sm text-foreground">{ask}</p>
          <div className="px-3 pb-2 pt-1">{status}</div>
        </div>
      </div>
    </div>
  );
}

/** 用户追问气泡（右侧·第三方）：驱动本轮的「你的追问」权威复盘——向谁问 + 原文 + 是否被承接。 */
export function InterjectionBubble({
  interjection,
  sides,
}: {
  interjection: DebateUserInterjection;
  sides: DebateSideModel[];
}) {
  const nameBySideKey = new Map(sides.map((s) => [s.sideKey, s.name]));
  const target = interjection.target_key
    ? (nameBySideKey.get(interjection.target_key) ?? interjection.target_key)
    : null;
  return (
    <AskBubble
      ask={interjection.ask}
      targetLabel={target ? `定向：${target}` : "全场"}
      status={
        <span
          className={
            interjection.answered
              ? statusPillInline.success
              : statusPillInline.muted
          }
        >
          {interjection.answered ? "✓ 已被承接" : "未及回应"}
        </span>
      }
    />
  );
}

/**
 * 站队投票 chip（发言气泡底 · 前端UX设计.md §4.1 蓝图：站队=气泡投票）—— 在某辩手气泡上标记
 * 你倾向这一方（再点取消）。纯用户侧记录、仅你可见、**不影响 AI 裁决**（守中立）；按语义 `sideKey`
 * 记入 {@link useDebateUserTake}（**会话内态、不持久化**）。同一方各轮气泡共享同一倾向态（点亮一致）。
 */
export function StanceVote({
  turnId,
  sideKey,
  name,
  colorVar,
}: {
  turnId: string;
  sideKey: string;
  name: string;
  colorVar: string;
}) {
  const stance = useDebateTake(turnId).stance;
  const setStance = useDebateUserTake((s) => s.setStance);
  const active = stance === sideKey;
  return (
    <SimpleTooltip label="你的倾向 · 仅你可见，不影响 AI 裁决">
      <button
        type="button"
        onClick={() => setStance(turnId, active ? null : sideKey)}
        aria-pressed={active}
        aria-label={active ? `取消倾向${name}` : `倾向${name}`}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors ${
          active
            ? ""
            : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
        }`}
        style={
          active
            ? {
                color: colorVar,
                borderColor: colorVar,
                backgroundColor: `color-mix(in oklch, ${colorVar} 14%, transparent)`,
              }
            : undefined
        }
      >
        <Hand size={12} />
        {active ? "你倾向这方" : "站这方"}
      </button>
    </SimpleTooltip>
  );
}
