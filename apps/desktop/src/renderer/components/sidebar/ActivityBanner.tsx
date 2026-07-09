import { useConversations } from "@/hooks/useConversations";
import {
  type ActiveConversation,
  deriveActiveConversations,
  summarizeActivity,
} from "@/lib/teamActivity";
import { useApprovalStore } from "@/stores/approvals";
import { DRAFT_KEY, useConversationStore } from "@/stores/conversation";
import { useSidebarStore } from "@/stores/sidebar";
import { ChevronDown, Loader2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

interface Props {
  collapsed: boolean;
}

/**
 * 全局活动横幅 (前端UX设计.md §一 全局协作感知)：坐在侧栏导航与对话列表之间，订阅所有对话的生成态 +
 * 审批态，摘要成「N 个任务执行中 · M 个待审批」。点击展开活跃对话清单，再点某行跳转过去；无
 * 活动时整块不渲染。让用户切到别处时仍感知「团队在跑」。
 */

/** 活跃对话集合的紧凑签名（排序后拼接 id）——只随「活跃对话集合」变化而变，回合流式的正文
 * 增量不触发横幅重渲染（zustand 选择器按值比较）。 */
function activeGeneratingKey(byId: Record<string, { isGenerating: boolean }>) {
  const ids: string[] = [];
  for (const [id, rt] of Object.entries(byId)) {
    if (id !== DRAFT_KEY && rt.isGenerating) ids.push(id);
  }
  return ids.sort().join(",");
}

function splitKey(key: string): string[] {
  return key ? key.split(",") : [];
}

function useActiveConversations(): ActiveConversation[] {
  const generatingKey = useConversationStore((s) =>
    activeGeneratingKey(s.byId),
  );
  const awaitingKey = useApprovalStore((s) =>
    [...new Set(s.pending.map((p) => p.conversationId))]
      .filter((id) => id && id !== DRAFT_KEY)
      .sort()
      .join(","),
  );
  const conversations = useConversations();

  const titleOf = (id: string) => conversations.find((c) => c.id === id)?.title;
  return deriveActiveConversations(
    splitKey(generatingKey),
    splitKey(awaitingKey),
    titleOf,
  );
}

export function ActivityBanner({ collapsed }: Props) {
  const active = useActiveConversations();
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const setSidebarCollapsed = useSidebarStore((s) => s.setCollapsed);

  const summary = summarizeActivity(active);
  if (!summary) return null;

  const open = (id: string) => {
    switchConversation(id);
    navigate(`/conversations/${id}`);
    setExpanded(false);
  };

  // Collapsed rail: a pulsing indicator that reopens the rail so the full
  // interactive banner (and its list) becomes reachable.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setSidebarCollapsed(false)}
        className="flex w-full justify-center border-b border-sidebar-border py-2"
        aria-label={summary}
        title={summary}
      >
        <span className="size-2 animate-pulse rounded-full bg-primary" />
      </button>
    );
  }

  return (
    <div className="border-b border-sidebar-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/50"
      >
        <Loader2 size={13} className="shrink-0 animate-spin text-primary" />
        <span className="flex-1 truncate text-xs text-sidebar-foreground/70">
          {summary}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-sidebar-foreground/40 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>
      {expanded && (
        <ul className="space-y-0.5 px-2 pb-2">
          {active.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => open(c.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              >
                <span
                  aria-label={c.status === "running" ? "执行中" : "待审批"}
                  className={`size-1.5 shrink-0 rounded-full bg-primary ${
                    c.status === "running" ? "animate-pulse" : ""
                  }`}
                />
                <span className="flex-1 truncate">{c.title}</span>
                {c.status === "awaiting" && (
                  <span className="shrink-0 text-xs text-sidebar-foreground/50">
                    待审批
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
