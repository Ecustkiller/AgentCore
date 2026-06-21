import { Button, DecisionCard, DecisionCardIcon } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { notifyError } from "@/lib/toast";
import { decideApproval, isFileOpTool } from "@/services/approvals";
import { type PendingApproval, useApprovalStore } from "@/stores/approvals";
import { useConversationStore } from "@/stores/conversation";
import type { ApprovalDecision } from "@/types/events";
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  FileCheck,
  Loader2,
  ShieldAlert,
  X,
} from "lucide-react";
import { useState } from "react";

const TOOL_LABELS: Record<string, string> = {
  file_write: "写入文件",
  str_replace: "修改文件",
  file_delete: "删除文件",
  file_move: "移动文件",
  code_execute: "执行代码",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function primaryArg(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path", "command", "code"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function ApprovalPrompt() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const pending = useApprovalStore((s) => s.pending);
  const visible = pending.filter((p) => p.conversationId === conversationId);
  if (visible.length === 0) return null;

  return (
    <div className="mx-4 mb-2 space-y-2">
      {visible.map((approval) => (
        <ApprovalCard key={approval.approvalId} approval={approval} />
      ))}
    </div>
  );
}

function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const [expanded, setExpanded] = useState(false);
  const [clicked, setClicked] = useState<ApprovalDecision | null>(null);

  const headline = primaryArg(approval.arguments);
  const argEntries = Object.entries(approval.arguments);
  const busy = approval.resolving;
  const isFileOp = isFileOpTool(approval.toolName);

  const onDecide = (decision: ApprovalDecision) => {
    setClicked(decision);
    void decideApproval(approval, decision).catch((err) => {
      notifyError(err, "操作失败");
    });
  };

  const spinnerOr = (decision: ApprovalDecision, icon: React.ReactNode) =>
    busy && clicked === decision ? (
      <Loader2 size={13} className="animate-spin" />
    ) : (
      icon
    );

  return (
    <DecisionCard tone="warning" animate className="mx-0">
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="warning">
          <ShieldAlert size={16} />
        </DecisionCardIcon>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">
            <span className="font-medium">Agent 请求执行</span>
            <span className="text-muted-foreground"> · </span>
            <span className="font-medium">{toolLabel(approval.toolName)}</span>
          </p>
          {headline && (
            <SimpleTooltip label={headline}>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {headline}
              </p>
            </SimpleTooltip>
          )}
          {argEntries.length > 0 && (
            <Button
              variant="ghost"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 h-auto gap-1 px-0 py-0 text-xs text-muted-foreground hover:text-foreground"
              icon={
                expanded ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )
              }
            >
              {expanded ? "收起参数" : "查看参数"}
            </Button>
          )}
          {expanded && argEntries.length > 0 && (
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-card/70 p-2 font-mono text-xs text-foreground">
              {JSON.stringify(approval.arguments, null, 2)}
            </pre>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Button
          variant="primary"
          icon={spinnerOr("approve", <Check size={13} />)}
          disabled={busy}
          onClick={() => onDecide("approve")}
        >
          允许一次
        </Button>
        <Button
          variant="neutral"
          icon={spinnerOr("approve_always", <CheckCheck size={13} />)}
          disabled={busy}
          onClick={() => onDecide("approve_always")}
        >
          本轮内都允许
        </Button>
        {isFileOp && (
          <Button
            variant="neutral"
            icon={spinnerOr("approve_always_files", <FileCheck size={13} />)}
            disabled={busy}
            onClick={() => onDecide("approve_always_files")}
          >
            本轮内允许所有文件改动
          </Button>
        )}
        <Button
          variant="danger"
          icon={spinnerOr("deny", <X size={13} />)}
          disabled={busy}
          onClick={() => onDecide("deny")}
        >
          拒绝
        </Button>
      </div>
    </DecisionCard>
  );
}
