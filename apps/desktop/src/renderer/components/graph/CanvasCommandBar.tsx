import { TurnComposer } from "@/components/chat/message-input/TurnComposer";

/**
 * Persistent bottom command bar for the team canvas (画布常驻命令栏，前端UX设计.md
 * §6.1 · §6.2): the unified {@link TurnComposer} — the SAME full composer as the
 * chat view's MessageInput (附件 / @ 文件引用 / 停止生成 / 后台云端 / 字数 / 回填),
 * in canvas chrome. 下达指令 is one act, so the two views share one core and one
 * per-conversation draft (switching 聊天 ⇄ 画布 keeps the half-typed order).
 *
 * Host-specific bits: the boss-facing placeholder, the 自动跟随 waiting hint, and
 * `onDispatch` — the host (对话级画布 overview {@link import("./ConversationCanvas")}
 * or full-screen turn detail {@link import("../../pages/TurnDetailPage").TurnDetailPage})
 * follows the new round in place when a foreground turn is dispatched.
 *
 * 后台云端 toggle (`allowBackground`): offered ONLY where the resulting 后台云端任务
 * card is afterward visible (the overview's 指挥台 feed), NOT the single-turn detail page.
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
  return (
    <div className="shrink-0 border-t border-border bg-background px-4 pb-4 pt-2">
      {waiting && (
        <div className="mx-auto mb-1 max-w-3xl text-xs text-muted-foreground">
          新回合执行中，画布将自动跟随…
        </div>
      )}
      <div className="mx-auto max-w-3xl">
        <TurnComposer
          placeholder="向 CEO 下达下一步指令…"
          allowBackground={allowBackground}
          onDispatch={onDispatch}
        />
      </div>
    </div>
  );
}
