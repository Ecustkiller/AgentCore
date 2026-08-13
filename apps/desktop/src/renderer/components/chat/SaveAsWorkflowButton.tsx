import { Button, Input } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { APP_PATHS } from "@/pages/toolbox/manual/paths";
import { ApiError } from "@/services/api";
import { type UserWorkflow, saveTurnAsWorkflow } from "@/services/workflows";
import { useConversationStore } from "@/stores/conversation";
import { type Execution, useExecutionScope } from "@/stores/execution";
import { CheckCircle2, Loader2, Workflow } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  WORKFLOW_SNAPSHOT_DEGRADE_NOTE,
  canSaveTurnAsWorkflow,
} from "./saveAsWorkflowGate";

const NAME_MAX = 120;
/** 任务标题当默认名：太长的一句话目标塞进列表会挤爆，截到能一眼扫完。 */
const NAME_PREFILL_MAX = 40;

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? (e.serverMessage ?? fallback) : fallback;
}

function prefillName(taskSummary: string): string {
  const s = taskSummary.trim().replace(/\s+/g, " ");
  if (s.length <= NAME_PREFILL_MAX) return s;
  return `${s.slice(0, NAME_PREFILL_MAX)}…`;
}

/**
 * 「把这轮协作存成工作流」——工作流的主入口（前端UX设计.md §三）。
 *
 * 只在完成态的多队员回合出现（{@link canSaveTurnAsWorkflow}）。definition 由服务端
 * 从本轮 journal 派生：前端的 `RunNode` 没有 deliverable，客户端拼不出忠实的交付契约，
 * 所以这里只交对话 / 消息标识与名字。
 *
 * 存过之后按钮改「已存为工作流」，再点是回到结果卡（去画布微调），不再重复提交；
 * 即便真的重复提交，服务端对同一轮幂等返回已有记录。
 */
export function SaveAsWorkflowButton({ execution }: { execution: Execution }) {
  const messageId = useExecutionScope();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<UserWorkflow | null>(null);

  if (!canSaveTurnAsWorkflow(execution) || !messageId || !conversationId) {
    return null;
  }

  return (
    <>
      <SimpleTooltip
        label={
          saved
            ? `本轮已存为「${saved.name}」，可去画布微调`
            : "把这轮的分工与先后顺序存成可复用的工作流"
        }
      >
        <Button
          variant="ghost"
          className="ml-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          icon={
            saved ? (
              <CheckCircle2 size={13} className="text-success" />
            ) : (
              <Workflow size={13} />
            )
          }
          data-testid="status-strip-save-as-workflow"
          onClick={() => setOpen(true)}
        >
          {saved ? "已存为工作流" : "存为工作流"}
        </Button>
      </SimpleTooltip>
      {open && (
        <SaveAsWorkflowDialog
          conversationId={conversationId}
          messageId={messageId}
          defaultName={prefillName(execution.taskSummary)}
          saved={saved}
          onSaved={setSaved}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * 命名 → 保存 → 结果两步走。
 *
 * 结果步不省：服务端带回的降级说明（本轮模型选择 / 辩论站位等不进快照）必须让用户读到
 * 再去画布，用一闪而过的 toast 承载等于藏。报错走 inline（对话框还在），与
 * `RunWorkflowDialog` 同口径。
 */
function SaveAsWorkflowDialog({
  conversationId,
  messageId,
  defaultName,
  saved,
  onSaved,
  onClose,
}: {
  conversationId: string;
  messageId: string;
  defaultName: string;
  saved: UserWorkflow | null;
  onSaved: (workflow: UserWorkflow) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(defaultName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onSaved(await saveTurnAsWorkflow(conversationId, messageId, { name }));
    } catch (e) {
      setError(errMsg(e, "存为工作流失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const openEditor = (workflowId: string) => {
    onClose();
    navigate(APP_PATHS.toolbox.workflows.edit(workflowId));
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        {saved ? (
          <>
            <DialogHeader>
              <DialogTitle>已存为工作流「{saved.name}」</DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-2">
                  <p>下次同类活可以直接跑，也能绑到常驻任务上。</p>
                  <p
                    className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-foreground"
                    data-testid="save-as-workflow-degrade"
                  >
                    {saved.description?.trim() ||
                      WORKFLOW_SNAPSHOT_DEGRADE_NOTE}
                  </p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="neutral" size="md" onClick={onClose}>
                留在对话
              </Button>
              <Button size="md" onClick={() => openEditor(saved.id)}>
                去微调
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>把这轮协作存成工作流</DialogTitle>
              <DialogDescription>
                按这轮的分工与先后顺序生成一张工作流，之后可以直接复跑或在画布上微调。
              </DialogDescription>
            </DialogHeader>

            <div className="px-5">
              <label className="block" htmlFor="save-as-workflow-name">
                <span className="mb-1 block text-xs text-muted-foreground">
                  名称（可选）
                </span>
                <Input
                  id="save-as-workflow-name"
                  className="w-full"
                  value={name}
                  maxLength={NAME_MAX}
                  placeholder="留空则按这轮任务自动命名"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {error && (
                <p
                  className="mt-2 text-xs text-destructive"
                  data-testid="save-as-workflow-error"
                >
                  {error}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button variant="neutral" size="md" onClick={onClose}>
                取消
              </Button>
              <Button
                size="md"
                disabled={submitting}
                icon={
                  submitting ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Workflow size={14} />
                  )
                }
                onClick={() => void submit()}
              >
                保存
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
