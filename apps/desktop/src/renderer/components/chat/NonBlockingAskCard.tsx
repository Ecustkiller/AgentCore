import { Button, DecisionCard } from "@/components/ui";
import { useComposerDraftStore } from "@/stores/composer";
import type { NonBlockingAskDisplay } from "@/stores/conversation";
import { CornerDownLeft } from "lucide-react";

export function NonBlockingAskCard({ ask }: { ask: NonBlockingAskDisplay }) {
  const fill = useComposerDraftStore((s) => s.fill);
  const multi = ask.questions.length > 1;
  const pick = (prompt: string, value: string) =>
    fill(multi && prompt ? `${prompt}：${value}` : value);

  return (
    <DecisionCard tone="primary" animate className="overflow-hidden p-0">
      <div className="space-y-3 px-3 pb-3 pt-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-primary">
            顺便确认下（已按默认继续）
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

        {ask.assumptions.length > 0 && (
          <div className="rounded-lg bg-muted/20 px-2.5 py-2">
            <p className="text-xs font-medium text-muted-foreground">
              默认方案
            </p>
            <div className="mt-1 space-y-0.5">
              {ask.assumptions.map((a) => (
                <div key={a.id} className="flex gap-1.5 text-xs">
                  <span className="w-14 shrink-0 text-muted-foreground">
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

        {ask.questions.map((q) => {
          // Uniform chip shape across kinds: a text question's default is its lone chip;
          // a choice question's options already carry label/detail/recommended.
          const chips =
            q.kind === "text"
              ? q.default
                ? [{ label: q.default }]
                : []
              : q.options;
          return (
            <div key={q.id} className="min-w-0">
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {q.prompt}
              </p>
              {chips.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {chips.map((opt) => {
                    const isDefault = !!q.default && opt.label === q.default;
                    return (
                      <Button
                        key={opt.label}
                        variant="ghost"
                        className="h-auto rounded-full bg-muted/40 px-2.5 py-1 text-xs text-foreground hover:bg-muted/60"
                        onClick={() => pick(q.prompt, opt.label)}
                      >
                        <span className="whitespace-pre-wrap">{opt.label}</span>
                        {opt.recommended && (
                          <span className="ml-1 text-muted-foreground">
                            ·推荐
                          </span>
                        )}
                        {isDefault && (
                          <span className="ml-1 text-muted-foreground">
                            ·默认
                          </span>
                        )}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {ask.styleOptions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {ask.styleOptions.map((s) => (
              <Button
                key={s.id}
                variant="ghost"
                className="h-auto rounded-full bg-muted/40 px-2.5 py-1 text-xs text-foreground hover:bg-muted/60"
                onClick={() => pick("风格", s.label)}
              >
                {s.label}
              </Button>
            ))}
          </div>
        )}

        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <CornerDownLeft size={12} className="shrink-0" />
          点选项即回填到下方输入框，可改后发送；不回复我就按默认继续。
        </p>
      </div>
    </DecisionCard>
  );
}
