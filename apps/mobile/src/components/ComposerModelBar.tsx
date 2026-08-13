import { Bot } from "lucide-react";

/**
 * Composer 上方常驻的「本会话跑在哪个模型组合上」——原先埋在「＋ → 更多」两层里，
 * 用户看不到会话钉死在平台预置组合上，接了自己的 API 仍撞限流才发现。
 *
 * 独立成行而不是塞进 composer：窄屏下主输入区不让宽。点击开的仍是同一个
 * ModelPicker，选择逻辑不变。
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
  return (
    <div className="composer-model-bar">
      <button
        type="button"
        className="composer-model-chip"
        data-testid="composer-model-chip"
        aria-label={`模型组合：${label}${preset ? "（系统预置）" : ""}`}
        disabled={disabled}
        onClick={onOpen}
      >
        <Bot size={13} className="composer-model-icon" aria-hidden />
        <span className="composer-model-name">{label}</span>
        {preset && <span className="model-preset-badge">预置</span>}
      </button>
    </div>
  );
}
