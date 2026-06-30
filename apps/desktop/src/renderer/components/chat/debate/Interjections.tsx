import {
  statusAccentText,
  statusPillInline,
  surfaceSubtle,
} from "@/components/ui/tone-presets";
import type { DebateUserInterjection } from "@/types/events";
import { MessageCircleQuestion } from "lucide-react";
import type { DebateSideModel } from "./model";

/**
 * 本轮「你的追问」复盘 (辩论编排设计.md §6.3)——把用户在【上一轮】
 * 边界注入、本轮辩手须正面回应的追问按原文铺出：向谁问 + 问题原文 + 是否被承接。`answered` 是
 * **结构事实**（是否真有后续轮跑起来答它，追问即续辩则恒真；轮数上限/收场边界追问则假），不是
 * 「答得好不好」的语义判断。守 AI 中立：仅复述用户动作，不碰裁决内容。一方收场 roster 才有名字，
 * 故 `target_key` 据本轮 `sides` 解析成展示名（解析不到原样退化）。无追问 → 不渲染。
 */
export function RoundInterjections({
  interjections,
  sides,
}: {
  interjections: DebateUserInterjection[];
  sides: DebateSideModel[];
}) {
  if (interjections.length === 0) return null;
  const nameBySideKey = new Map(sides.map((s) => [s.sideKey, s.name]));
  return (
    <div className={`rounded-lg border p-2.5 ${surfaceSubtle.primary}`}>
      <h5
        className={`mb-1.5 flex items-center gap-1 text-xs font-medium ${statusAccentText.primary}`}
      >
        <MessageCircleQuestion size={12} />
        你的追问
      </h5>
      <ul className="space-y-1.5">
        {interjections.map((it, i) => {
          const target = it.target_key
            ? (nameBySideKey.get(it.target_key) ?? it.target_key)
            : null;
          return (
            <li
              key={`${it.ask}-${i}`}
              className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm"
            >
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                {target ? `向 ${target}` : "向全场"}
              </span>
              <span className="min-w-0 flex-1 text-foreground">{it.ask}</span>
              <span
                className={
                  it.answered
                    ? statusPillInline.success
                    : statusPillInline.muted
                }
              >
                {it.answered ? "已请辩手回应" : "未及回应"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
