/**
 * 建会话中：草稿首发时输入框在创建 POST 发出前就清空了，这条弱提示替它顶住那段等待。
 * 「按下发送后界面毫无变化」正是用户再按一次、建出两条会话的直接诱因。
 */
import { Loader2 } from "lucide-react";

export const COMPOSER_CREATING_HINT = "正在创建对话…";

export function ComposerCreatingNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      aria-live="polite"
      data-testid="composer-creating-notice"
      className="flex items-center gap-1.5 px-4 pt-2 text-xs text-muted-foreground"
    >
      <Loader2 size={12} className="animate-spin" aria-hidden />
      {COMPOSER_CREATING_HINT}
    </div>
  );
}
