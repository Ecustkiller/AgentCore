import { dispatchBackgroundTask } from "@/components/chat/message-input/dispatchBackgroundTask";
import { IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { sendQuickTurn } from "@/services/turns";
import { useBackgroundTasksStore } from "@/stores/backgroundTasks";
import {
  useActiveGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { ArrowUp, Cloud, CloudUpload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Persistent bottom command bar for the team canvas (画布常驻命令栏，前端UX设计.md
 * §6.1 · §6.2). Dispatches a foreground turn via {@link sendQuickTurn}; the host (the
 * on-demand full-screen overlay {@link import("./TeamGraphFullscreen")} or the 对话级
 * 画布 {@link import("./ConversationCanvas")}) follows the new round in place.
 *
 * 后台云端 toggle (`allowBackground`): a local-mode conversation can hand a task to a
 * cloud team instead — non-blocking, so it spawns no foreground round but a 后台云端
 * 任务 ({@link dispatchBackgroundTask}). Offered ONLY where that card is afterward
 * visible (the 对话级画布's 指挥台 feed), NOT the single-turn fullscreen overlay.
 * Mirrors chat's MessageInput toggle (same gate + dispatch, single data source).
 *
 * Text-only — attachments stay in the main composer. Rendered only in canvas mode (the
 * conversation's view set to "canvas"), so the default chat experience is unchanged.
 */
export function CanvasCommandBar({
  onDispatch,
  waiting,
  allowBackground = false,
}: {
  onDispatch: () => void;
  waiting: boolean;
  allowBackground?: boolean;
}) {
  const [value, setValue] = useState("");
  // Turns don't stack: while this turn (or any) is generating, the order can be
  // typed but not sent (mirrors the composer). `sendQuickTurn` re-checks too.
  const generating = useActiveGenerating();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = !generating && value.trim().length > 0;

  // 后台云端任务 gate: only local-mode conversations can hand off to a cloud team, so
  // resolve the bound mode (shared store, deduped) and show the toggle only then —
  // reset when the host opts out or the bound conversation isn't local.
  const [isLocal, setIsLocal] = useState(false);
  const [backgroundMode, setBackgroundMode] = useState(false);
  useEffect(() => {
    if (!allowBackground || !conversationId) {
      setIsLocal(false);
      setBackgroundMode(false);
      return;
    }
    let cancelled = false;
    void useBackgroundTasksStore
      .getState()
      .ensureMode(conversationId)
      .then((mode) => {
        if (cancelled) return;
        const local = mode === "local";
        setIsLocal(local);
        if (!local) setBackgroundMode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [allowBackground, conversationId]);
  const showBackground = allowBackground && isLocal;
  const bg = showBackground && backgroundMode;

  const send = () => {
    if (!canSend) return;
    const text = value.trim();
    setValue("");
    if (ref.current) ref.current.style.height = "";
    // 后台云端: hand the task to a cloud team — non-blocking, no foreground round to
    // follow (skip onDispatch); it surfaces as a 后台云端任务 card in the 指挥台.
    if (bg && conversationId) {
      dispatchBackgroundTask(conversationId, text);
      return;
    }
    // Foreground turn: start following before it resolves — the new bubble lands
    // almost at once and the host's follow effect reacts to it. `sendQuickTurn`
    // streams to completion on its own (canSend already gated its re-checked guards).
    onDispatch();
    void sendQuickTurn(text);
  };

  return (
    <div className="shrink-0 border-t border-border bg-card px-4 py-3">
      {waiting && (
        <div className="mx-auto mb-2 max-w-3xl text-xs text-muted-foreground">
          新回合执行中，画布将自动跟随…
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        {showBackground && (
          <SimpleTooltip
            label={
              bg
                ? "已切到「后台云端」：发送会把任务交给云端团队后台跑"
                : "切到「后台云端」：把任务交给云端团队后台跑，结果回来再应用"
            }
          >
            <IconButton
              size="md"
              onClick={() => setBackgroundMode((v) => !v)}
              disabled={generating}
              aria-label="切换后台云端任务"
              aria-pressed={bg}
              className={`size-10 shrink-0 rounded-xl ${
                bg ? "bg-primary/10 text-primary" : ""
              }`}
            >
              <Cloud size={18} />
            </IconButton>          </SimpleTooltip>
        )}
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            e.target.style.height = "0";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder={
            bg
              ? "描述要交给云端团队后台完成的任务…"
              : "向 CEO 下达下一步指令…"
          }
          className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <SimpleTooltip
          label={
            generating
              ? "团队执行中，待完成"
              : bg
                ? "派发到云端后台"
                : "下达指令 (Enter)"
          }
        >
          <IconButton
            size="md"
            tone="primary"
            onClick={send}
            disabled={!canSend}
            aria-label={bg ? "派发到云端后台" : "下达指令"}
            className="size-10 shrink-0 rounded-xl"
          >
            {bg ? <CloudUpload size={18} /> : <ArrowUp size={18} />}
          </IconButton>        </SimpleTooltip>
      </div>
    </div>
  );
}
