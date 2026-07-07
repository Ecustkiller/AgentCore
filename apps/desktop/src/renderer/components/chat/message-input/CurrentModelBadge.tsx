import { SimpleTooltip } from "@/components/ui/tooltip";
import { useLlmKey } from "@/hooks/useLlmKey";
import { Bot, Loader2 } from "lucide-react";

/**
 * Read-only「当前模型」展示 — replaces the retired per-conversation 质量档 picker.
 * Shows the user's configured `default_model` from BYOK settings.
 */
export function CurrentModelBadge({ disabled }: { disabled?: boolean }) {
  const { data, isLoading } = useLlmKey();

  if (isLoading) {
    return (
      <span className="inline-flex h-8 items-center gap-1 px-2 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
      </span>
    );
  }

  const label =
    data?.default_model?.trim() ||
    data?.platform_model?.trim() ||
    (data?.billing_mode === "platform"
      ? "平台模型"
      : data?.configured
        ? "已配置模型"
        : "未配置");

  return (
    <SimpleTooltip label="当前模型（在设置 · 模型配置中修改）">
      <span
        className={`inline-flex h-8 max-w-40 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground ${
          disabled ? "opacity-60" : ""
        }`}
        aria-label={`当前模型：${label}`}
      >
        <Bot size={14} className="shrink-0" />
        <span className="truncate font-mono">{label}</span>
      </span>
    </SimpleTooltip>
  );
}
