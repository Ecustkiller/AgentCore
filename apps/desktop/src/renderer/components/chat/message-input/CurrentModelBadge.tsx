import { SimpleTooltip } from "@/components/ui/tooltip";
import { useLlmKey } from "@/hooks/useLlmKey";
import { useConversationStore } from "@/stores/conversation";
import { useTurnModelStore } from "@/stores/turnModel";
import { Bot, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * 「当前模型」展示 — 未配置时可点，直达接入流程 / 模型配置。
 *
 * Shows the model **this conversation's last turn actually ran on** when known — the
 * local (sidecar) turn result reports its real model ({@link useTurnModelStore}), which
 * is the ONLY place a turn can diverge from the account config: a dev fallback runs on
 * the local platform model (e.g. gpt-5.5) instead of the account model (e.g. deepseek-…).
 * With no per-turn signal yet (a fresh conversation, or a cloud conversation — cloud
 * always uses the account model, so the config label is already correct) it falls back
 * to the account config (`default_model` from `GET /v1/users/me/llm-key`).
 */
export function CurrentModelBadge({ disabled }: { disabled?: boolean }) {
  const { data, isLoading } = useLlmKey();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const lastTurnModel = useTurnModelStore((s) =>
    conversationId ? s.byConversation[conversationId] : undefined,
  );
  const navigate = useNavigate();

  // Only wait on the account-config fetch when there's no per-turn model to show.
  if (isLoading && !lastTurnModel) {
    return (
      <span className="inline-flex h-8 items-center gap-1 px-2 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
      </span>
    );
  }

  const configured = !!data?.configured || data?.billing_mode === "platform";
  const accountLabel =
    data?.default_model?.trim() ||
    data?.platform_model?.trim() ||
    (data?.billing_mode === "platform"
      ? "平台模型"
      : data?.configured
        ? "已配置模型"
        : "未配置");
  const label = lastTurnModel ?? accountLabel;
  const unconfigured = !configured && !lastTurnModel;

  const goConfigure = () => {
    if (disabled) return;
    navigate("/more/model");
  };

  const body = (
    <>
      <Bot size={14} className="shrink-0" />
      <span className="truncate font-mono">{label}</span>
    </>
  );

  if (unconfigured) {
    return (
      <SimpleTooltip label="点击配置模型">
        <button
          type="button"
          onClick={goConfigure}
          disabled={disabled}
          aria-label="未配置模型，点击前往配置"
          className={`inline-flex h-8 max-w-40 items-center gap-1 rounded-lg px-2 text-xs text-warning hover:bg-warning/10 ${
            disabled ? "cursor-not-allowed opacity-60" : ""
          }`}
        >
          {body}
        </button>
      </SimpleTooltip>
    );
  }

  return (
    <SimpleTooltip
      label={
        lastTurnModel
          ? "本会话上一回合实际使用的模型"
          : "当前模型（在设置 · 模型配置中修改）"
      }
    >
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          navigate("/more/model");
        }}
        disabled={disabled}
        aria-label={`当前模型：${label}`}
        className={`inline-flex h-8 max-w-40 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground ${
          disabled ? "cursor-not-allowed opacity-60" : ""
        }`}
      >
        {body}
      </button>
    </SimpleTooltip>
  );
}
