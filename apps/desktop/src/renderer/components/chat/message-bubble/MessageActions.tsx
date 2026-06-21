import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { formatMessageTime } from "@/lib/format";
import { notifyError } from "@/lib/toast";
import { deleteMessage, getMessagePrompt } from "@/services/messages";
import { useConversationStore } from "@/stores/conversation";
import { Check, Copy, ScrollText, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useCopyAction } from "./useCopyAction";

/** Small icon+label action shown beneath a message on hover. */
export function MessageAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function DeleteMessageAction({ messageId }: { messageId: string }) {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const [confirming, setConfirming] = useState(false);

  const onDelete = async () => {
    setConfirming(false);
    if (!conversationId) return;
    try {
      await deleteMessage(conversationId, messageId);
    } catch (err) {
      notifyError(err, "删除失败");
    }
  };

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => void onDelete()}
          className="inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
        >
          <Check size={13} />
          <span>确认删除</span>
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X size={13} />
          <span>取消</span>
        </button>
      </span>
    );
  }

  return (
    <MessageAction
      icon={<Trash2 size={13} />}
      label="删除"
      onClick={() => setConfirming(true)}
    />
  );
}

type PromptState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "empty" };

export function ViewPromptAction({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PromptState>({ status: "loading" });
  const { copied, onCopy } = useCopyAction(() =>
    state.status === "ready" ? state.text : "",
  );

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setState({ status: "loading" });
      getMessagePrompt(conversationId, messageId)
        .then((text) => setState({ status: "ready", text }))
        .catch(() => setState({ status: "empty" }));
    }
  };

  return (
    <>
      <MessageAction
        icon={<ScrollText size={13} />}
        label="提示词"
        onClick={() => onOpenChange(true)}
      />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle>本回合系统提示词</DialogTitle>
            <DialogDescription>
              AI
              本回合实际遵循的逐字系统提示词（含当日日期、能力目录等动态内容）。
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden px-5 pb-5">
            {state.status === "loading" && (
              <p className="py-8 text-center text-muted-foreground text-sm">
                加载中…
              </p>
            )}
            {state.status === "empty" && (
              <p className="py-8 text-center text-muted-foreground text-sm">
                本回合没有可查看的提示词。
              </p>
            )}
            {state.status === "ready" && (
              <div className="flex h-full min-h-0 flex-col">
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    onClick={onCopy}
                    className="inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-3 py-2 text-foreground/90 text-xs leading-relaxed">
                  {state.text}
                </pre>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function MessageTime({ iso }: { iso: string }) {
  const label = formatMessageTime(iso);
  if (!label) return null;
  return (
    <SimpleTooltip label={new Date(iso).toLocaleString()}>
      <span className="ml-1 cursor-default text-xs text-muted-foreground/60">
        {label}
      </span>
    </SimpleTooltip>
  );
}
