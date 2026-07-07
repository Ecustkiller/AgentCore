import type { DebateModel } from "../model";

/** 主持人开场白：优先 `opening`，否则 motion + 首轮焦点模板。空串 ⇒ 不渲染。 */
export function openingText(model: DebateModel): string {
  if (model.opening) return model.opening.trim();
  const firstFocus = model.rounds[0]?.focus?.trim() ?? "";
  const motion = model.motion?.trim() ?? "";
  if (motion && firstFocus)
    return `本场要定的是：${motion}。先从最要害的「${firstFocus}」切入。`;
  if (firstFocus) return `先从最要害的「${firstFocus}」切入。`;
  if (motion) return `本场要定的是：${motion}。`;
  return "";
}
