import type { DebateModel } from "../model";

/**
 * 主持人开场白文案（顶部「会说话的主持人」气泡）—— 优先用收场时主持人真写的 `opening`（AI 定调，
 * 能点出「为何从这个焦点切入」）；空 / 进行中 / 旧产物则回落到由 motion + 首轮焦点拼出的**模板开场白**
 * （安全网，永远有话可说）。返回空串 ⇒ 尚无任何可说内容（无 motion 也无首轮焦点）⇒ 不渲染开场气泡。
 */
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
