import { Bot } from "lucide-react";

/**
 * Composer 行内模型组合 chip（＋ 与输入之间）。
 * 窄屏限宽省略，完整名走 aria-label / title；点击仍开同一个 ModelPicker。
 */
export function ComposerModelBar({
  label,
  preset,
  disabled,
  onOpen,
}: {
  label: string;
  /** 系统预置组合（区别于用户自建），与桌面折叠态 chip 同一视觉语汇。 */
  preset: boolean;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const fullName = `模型组合：${label}${preset ? "（系统预置）" : ""}`;
  return (
    <button
      type="button"
      className="composer-model-chip"
      data-testid="composer-model-chip"
      aria-label={fullName}
      title={label}
      disabled={disabled}
      onClick={onOpen}
    >
      <Bot size={13} className="composer-model-icon" aria-hidden />
      <span className="composer-model-name">{label}</span>
      {preset && <span className="model-preset-badge">预置</span>}
    </button>
  );
}
