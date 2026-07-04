import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  patchConversationCache,
  useConversations,
} from "@/hooks/useConversations";
import { useModelModes } from "@/hooks/useModelModes";
import { notifyError } from "@/lib/toast";
import { setConversationModelMode } from "@/services/conversations";
import { modeLabel, presetLabel } from "@/services/modelModes";
import { Check, SlidersHorizontal } from "lucide-react";

/**
 * 质量档选择器 (per-conversation) — a compact composer-toolbar dropdown that
 * overrides which model tier THIS conversation runs on (经济 / 高质 / a custom
 * 质量档), or「跟随默认」to inherit the account/system default.
 *
 * Scope note (对话基础功能补齐 · 会话级选择器 + 账户默认档): this only overrides an
 * EXISTING conversation, so the host renders it only once a `conversationId`
 * exists. Brand-new chats simply start on the account default (set in 设置 → 模型
 * 配置); the override becomes available after the first turn creates the row.
 *
 * The current tier is read from the conversation cache and the change is optimistic
 * (the label flips at once, reverting on a failed persist), mirroring the other
 * sidebar mutations.
 */
export function ModelModePicker({
  conversationId,
  disabled,
}: {
  conversationId: string;
  disabled?: boolean;
}) {
  const { data: modes } = useModelModes();
  const conversation = useConversations().find((c) => c.id === conversationId);
  const current = conversation?.modelMode ?? null;

  // Don't render until the option space is known — an empty picker is worse than
  // briefly no picker, and it avoids flashing「默认」before presets arrive.
  if (!modes) return null;

  const defaultLabel = modeLabel(modes.defaultMode, modes);
  const currentLabel = current === null ? "默认" : modeLabel(current, modes);

  const select = (next: string | null) => {
    if (next === current) return;
    const prev = current;
    patchConversationCache(conversationId, { modelMode: next });
    void setConversationModelMode(conversationId, next).catch((err) => {
      patchConversationCache(conversationId, { modelMode: prev });
      notifyError(err, "切换质量档失败");
    });
  };

  const row = (
    active: boolean,
    label: string,
    hint: string | null,
    onSelect: () => void,
    key: string,
  ) => (
    <DropdownMenuItem key={key} onSelect={onSelect}>
      <span className="flex-1 truncate">
        {label}
        {hint && (
          <span className="ml-1 text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
      {active && <Check size={13} className="shrink-0" />}
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu>
      <SimpleTooltip label="质量档：切换本对话使用的模型档位">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={`质量档：${currentLabel}`}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
          >
            <SlidersHorizontal size={14} className="shrink-0" />
            <span className="max-w-24 truncate">{currentLabel}</span>
          </button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel>质量档</DropdownMenuLabel>
        {row(
          current === null,
          "跟随默认",
          `（${defaultLabel}）`,
          () => select(null),
          "__default__",
        )}
        {modes.presets.length > 0 && <DropdownMenuSeparator />}
        {modes.presets.map((p) =>
          row(
            current === p.key,
            presetLabel(p.key),
            null,
            () => select(p.key),
            `preset:${p.key}`,
          ),
        )}
        {modes.custom.length > 0 && <DropdownMenuSeparator />}
        {modes.custom.map((m) =>
          row(
            current === m.id,
            m.name,
            null,
            () => select(m.id),
            `custom:${m.id}`,
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
