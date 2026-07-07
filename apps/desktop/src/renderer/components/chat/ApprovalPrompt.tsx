import { CodeBlock } from "@/components/chat/CodeBlock";
import {
  codeExecuteLanguage,
  deriveCodeExecuteRiskTags,
  fencedCodeMarkdown,
  isPreviewTruncated,
} from "@/components/chat/codeExecuteApproval";
import { Badge, Button, DecisionCard, DecisionCardIcon } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { notifyError } from "@/lib/toast";
import {
  decideApproval,
  isFileOpTool,
  supportsTurnGrant,
} from "@/services/approvals";
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
import { type ComponentPropsWithoutRef, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";

const TOOL_LABELS: Record<string, string> = {
  file_write: "写入文件",
  file_append: "追加文件",
  str_replace: "修改文件",
  file_delete: "删除文件",
  file_move: "移动文件",
  code_execute: "执行代码",
};

const HIGHLIGHT_PLUGINS: ComponentPropsWithoutRef<
  typeof ReactMarkdown
>["rehypePlugins"] = [[rehypeHighlight, { ignoreMissing: true }]];

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function primaryArg(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName === "code_execute") {
    const purpose = args.purpose;
    if (typeof purpose === "string" && purpose.trim()) return purpose.trim();
  }
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

  const isCodeExecute = approval.toolName === "code_execute";
  const headline = primaryArg(approval.toolName, approval.arguments);
  const argEntries = Object.entries(approval.arguments);
  const busy = approval.resolving;
  const isFileOp = isFileOpTool(approval.toolName);

  const codeText =
    isCodeExecute && typeof approval.arguments.code === "string"
      ? approval.arguments.code
      : null;
  const riskTags = useMemo(
    () => (codeText ? deriveCodeExecuteRiskTags(codeText) : []),
    [codeText],
  );
  const codeTruncated = codeText != null && isPreviewTruncated(codeText);
  const otherArgs = useMemo(() => {
    if (!isCodeExecute) return approval.arguments;
    return Object.fromEntries(
      Object.entries(approval.arguments).filter(
        ([key]) => key !== "code" && key !== "purpose",
      ),
    );
  }, [approval.arguments, isCodeExecute]);

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
    <DecisionCard tone="primary" animate className="mx-0">
      <div className="flex items-start gap-2">
        <DecisionCardIcon tone="primary">
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
              <p
                className={`mt-0.5 truncate text-xs text-muted-foreground ${
                  isCodeExecute &&
                  typeof approval.arguments.purpose === "string" &&
                  approval.arguments.purpose.trim()
                    ? ""
                    : "font-mono"
                }`}
              >
                {headline}
              </p>
            </SimpleTooltip>
          )}
          {isCodeExecute && riskTags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {riskTags.map((tag) => (
                <Badge key={tag} tone="muted" className="font-normal">
                  {tag}
                </Badge>
              ))}
            </div>
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
          {expanded && isCodeExecute && codeText != null && (
            <div className="mt-1 space-y-1">
              {codeTruncated && (
                <p className="text-xs text-muted-foreground">代码预览已截断</p>
              )}
              <ApprovalHighlightedCode
                code={codeText}
                language={codeExecuteLanguage(approval.arguments)}
              />
            </div>
          )}
          {expanded && isCodeExecute && Object.keys(otherArgs).length > 0 && (
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-card/70 p-2 font-mono text-xs text-foreground">
              {JSON.stringify(otherArgs, null, 2)}
            </pre>
          )}
          {expanded && !isCodeExecute && argEntries.length > 0 && (
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
        {supportsTurnGrant(approval.toolName) && (
          <Button
            variant="neutral"
            icon={spinnerOr("approve_always", <CheckCheck size={13} />)}
            disabled={busy}
            onClick={() => onDecide("approve_always")}
          >
            本轮内都允许
          </Button>
        )}
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

function ApprovalHighlightedCode({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const markdown = useMemo(
    () => fencedCodeMarkdown(code, language),
    [code, language],
  );
  return (
    <ReactMarkdown
      rehypePlugins={HIGHLIGHT_PLUGINS}
      components={{
        pre: CodeBlock,
        p: ({ children }) => <>{children}</>,
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
