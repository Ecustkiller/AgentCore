/**
 * 「某个对话在等你」全局提示条（firehose `ai_attention`）。
 *
 * 只在人不在那个对话页时才有意义——停在该对话页时 ResumeCard / PauseCard 本身就是提示面，
 * 这里让位，免得同一件事说两遍。多条等待只显示最近一条 + 计数，点「去看看」进那个对话。
 * 版式沿用 OutdatedAndroidBanner：文档流内把下面的壳顶下去，不浮在内容上遮东西。
 */
import { useAiAttention } from "@/lib/aiAttention";
import { useLocation, useNavigate } from "react-router-dom";

/** 当前停留的对话 id（`/c/:id` 及其子页如 `/c/:id/files`）；不在对话页时为空。 */
function activeConversationId(pathname: string): string {
  return /^\/c\/([^/]+)/.exec(pathname)?.[1] ?? "";
}

export function AiAttentionBanner() {
  const entries = useAiAttention();
  const location = useLocation();
  const navigate = useNavigate();

  const active = activeConversationId(location.pathname);
  const waiting = entries.filter((e) => e.conversationId !== active);
  const latest = waiting[waiting.length - 1];
  if (!latest) return null;

  const others = waiting.length - 1;

  return (
    // biome-ignore lint/a11y/useSemanticElements: 内嵌 CTA，<output> 语义不符——保留 aria live 容器。
    <div className="ai-attention-banner" role="status">
      <span className="ai-attention-banner-label">需要你</span>
      <span className="ai-attention-banner-text">
        {latest.title || "有个对话在等你确认"}
        {others > 0 ? `（还有 ${others} 个）` : ""}
      </span>
      <button
        type="button"
        className="ai-attention-banner-cta"
        onClick={() => navigate(`/c/${latest.conversationId}`)}
      >
        去看看
      </button>
    </div>
  );
}
