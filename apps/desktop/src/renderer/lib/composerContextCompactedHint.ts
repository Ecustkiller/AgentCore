import { formatLocalMoment } from "@/lib/recoveryMoment";
import type { ConversationContextGap } from "@/stores/conversation";

/** Session-level light tip when rolling context compaction has run (无摘要正文). */
export const COMPOSER_CONTEXT_COMPACTED_HINT = "较早对话已压缩";

/**
 * 压缩没跟上、早期对话真的掉出窗口时的降级文案（后端 `context_gap` 为准）。
 *
 * 同一条灰字带的失败面。压缩成功说「已压缩」，压缩失败到丢历史却沉默，用户只会体感
 * 「AI 越聊越忘事」——线上就这么过了一整天才靠报障发现。所以这里要一次说清四件事：
 * 什么没做成（没压成摘要）、代价是什么（这一轮读不到最早的 N 条）、**没**丢什么
 * （原文仍在时间线上）、以及能怎么办（自动重试 / 上游恢复时刻 + 自己把要点再说一遍）。
 *
 * 照记忆常驻配额卡的诚实性范式：不能读成「AI 从此记不住东西」。缺 `recoveryAt`
 * 时只说会自动重试，绝不自行编造一个恢复时间——不知道就说不知道。恢复时刻是后端下发的
 * 绝对瞬间，按用户本机时区成文（不标时区名，屏幕上的钟就是他自己的）。
 *
 * 返回 `null` = 没有可诚实陈述的损失，什么都不显示。
 */
export function composerContextGapHint(
  gap: ConversationContextGap | undefined,
): string | null {
  const dropped = gap?.droppedMessages ?? 0;
  if (dropped < 1) return null;
  const moment = formatLocalMoment(gap?.recoveryAt);
  const relief = moment
    ? `上游额度将于 ${moment} 恢复，届时自动补上`
    : "系统会自动重试补上";
  return `较早对话没能压缩成摘要，这一轮 AI 读不到最早的 ${dropped} 条（原文都在，向上翻可见）。${relief}；急着用到时，把要点再说一遍即可。`;
}
