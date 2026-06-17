import { useComposerDraftStore } from "@/stores/composer";
import type { NonBlockingAskDisplay } from "@/stores/conversation";
import { CircleHelp, CornerDownLeft } from "lucide-react";

/**
 * Inline non-blocking ask card — the CEO posted a question via `ask_user(blocking=false)`
 * (Cursor 式) and KEPT WORKING on its stated default. Unlike {@link CheckpointCard} it
 * does NOT gate the turn: there are no 提交/停止 CTAs and no resolve. Instead it shows
 * the question + the defaults the CEO is proceeding on (read-only), and renders each
 * option as a quick-fill chip — clicking one 回填s the composer (the user's answer then
 * rides an ordinary next-turn message). Rendered under the assistant bubble that posted
 * it (会话流内), and replayed inline on reload from the journaled `question_posted`.
 *
 * Tone is `info` (蓝, 信息提示) — calm and FYI, distinct from the blocking card's
 * primary(开场)/warning(途中) gates: this is "我已假设 X，你可改" not "等你拍板".
 */
export function NonBlockingAskCard({ ask }: { ask: NonBlockingAskDisplay }) {
  const fill = useComposerDraftStore((s) => s.fill);
  // With one question the option alone is unambiguous; with several, prefix the prompt
  // so the stacked draft stays readable for the CEO (the only reader of the next message).
  const multi = ask.questions.length > 1;
  const pick = (prompt: string, value: string) =>
    fill(multi && prompt ? `${prompt}：${value}` : value);

  return (
    <div className="animate-task-card-enter mt-2 overflow-hidden rounded-xl border border-info/30 bg-info/5">
      <div className="space-y-3 px-3 pb-3 pt-3">
        <div className="flex items-start gap-2">
          <CircleHelp size={16} className="mt-0.5 shrink-0 text-info" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-info">
              想跟你确认（不阻塞 · 我已按默认继续）
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
              {ask.question}
            </p>
            {ask.context && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {ask.context}
              </p>
            )}
          </div>
        </div>

        {/* 我先按这些默认推进：the CEO's stated assumptions (read-only). */}
        {ask.assumptions.length > 0 && (
          <div className="rounded-lg border-l-2 border-info/30 bg-muted/40 px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">
              我先按这些默认推进
            </p>
            <div className="mt-1.5 space-y-1">
              {ask.assumptions.map((a) => (
                <div key={a.id} className="flex gap-2 text-xs">
                  <span className="w-16 shrink-0 text-muted-foreground">
                    {a.label}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap text-foreground">
                    {a.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Each question's options as quick-fill chips (回填, not a gating form). */}
        {ask.questions.map((q) => {
          const chips =
            q.kind === "text" ? (q.default ? [q.default] : []) : q.options;
          return (
            <div key={q.id} className="min-w-0">
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {q.prompt}
              </p>
              {chips.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {chips.map((opt) => {
                    const isDefault = !!q.default && opt === q.default;
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => pick(q.prompt, opt)}
                        className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-info/40 hover:bg-accent hover:text-foreground"
                      >
                        <span className="whitespace-pre-wrap">{opt}</span>
                        {isDefault && (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            默认
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* 风格预设 (visual products) — also quick-fill chips. */}
        {ask.styleOptions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {ask.styleOptions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => pick("风格", s.label)}
                className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-info/40 hover:bg-accent hover:text-foreground"
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <CornerDownLeft size={12} className="shrink-0" />
          点选项即回填到下方输入框，可改后发送；不回复我就按默认继续。
        </p>
      </div>
    </div>
  );
}
