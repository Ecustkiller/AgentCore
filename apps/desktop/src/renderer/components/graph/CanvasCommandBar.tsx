import { SimpleTooltip } from "@/components/ui/tooltip";
import { sendQuickTurn } from "@/services/turns";
import { useActiveGenerating } from "@/stores/conversation";
import { ArrowUp } from "lucide-react";
import { useRef, useState } from "react";

/**
 * Persistent bottom command bar for the team canvas (作战室常驻命令栏，协作图主界面
 * 化设计 §三 ① / §六 阶段 1）. Dispatches a turn via {@link sendQuickTurn}; the host
 * (the on-demand full-screen overlay {@link import("./TeamGraphFullscreen")} or the
 * 对话级画布 {@link import("./ConversationCanvas")}) follows the new round in place.
 *
 * Text-only — attachments stay in the main composer. Rendered only in canvas mode
 * (gated by `graphPrimary` at the host), so the default chat experience is unchanged.
 */
export function CanvasCommandBar({
  onDispatch,
  waiting,
}: {
  onDispatch: () => void;
  waiting: boolean;
}) {
  const [value, setValue] = useState("");
  // Turns don't stack: while this turn (or any) is generating, the order can be
  // typed but not sent (mirrors the composer). `sendQuickTurn` re-checks too.
  const generating = useActiveGenerating();
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = !generating && value.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    const text = value.trim();
    setValue("");
    if (ref.current) ref.current.style.height = "";
    // Start following before the turn resolves: the new bubble lands almost at once
    // and the host's follow effect reacts to it. `sendQuickTurn` streams to
    // completion on its own (canSend already gated the guards it re-checks).
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
          placeholder="向 CEO 下达下一步指令…"
          className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <SimpleTooltip
          label={generating ? "团队执行中，待完成" : "下达指令 (Enter)"}
        >
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            aria-label="下达指令"
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            <ArrowUp size={18} />
          </button>
        </SimpleTooltip>
      </div>
    </div>
  );
}
