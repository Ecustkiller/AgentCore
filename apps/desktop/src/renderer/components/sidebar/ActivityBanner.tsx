import { useApprovalStore } from "@/stores/approvals";
import { useConversationStore } from "@/stores/conversation";
import { Loader2 } from "lucide-react";

interface Props {
  collapsed: boolean;
}

function useActivitySummary(): string | null {
  const generatingCount = useConversationStore((s) => {
    let count = 0;
    for (const runtime of Object.values(s.byId)) {
      if (runtime.isGenerating) count++;
    }
    return count;
  });

  const approvalCount = useApprovalStore((s) => {
    const set = new Set(s.pending.map((p) => p.conversationId));
    return set.size;
  });

  if (generatingCount === 0 && approvalCount === 0) return null;

  const parts: string[] = [];
  if (generatingCount > 0) {
    parts.push(`${generatingCount} 个任务执行中`);
  }
  if (approvalCount > 0) {
    parts.push(`${approvalCount} 个待审批`);
  }
  return parts.join(" · ");
}

export function ActivityBanner({ collapsed }: Props) {
  const summary = useActivitySummary();

  if (!summary) return null;

  if (collapsed) {
    return (
      <div className="flex justify-center border-b border-sidebar-border py-2">
        <span className="size-2 animate-pulse rounded-full bg-primary" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-b border-sidebar-border px-3 py-2">
      <Loader2 size={13} className="shrink-0 animate-spin text-primary" />
      <span className="truncate text-xs text-sidebar-foreground/70">
        {summary}
      </span>
    </div>
  );
}
