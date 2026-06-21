import { Badge, Button, DecisionCard, DecisionCardIcon } from "@/components/ui";
import { useComposerDraftStore } from "@/stores/composer";
import type { NonBlockingAskDisplay } from "@/stores/conversation";
import { CircleHelp, CornerDownLeft } from "lucide-react";

export function NonBlockingAskCard({ ask }: { ask: NonBlockingAskDisplay }) {
  const fill = useComposerDraftStore((s) => s.fill);
  const multi = ask.questions.length > 1;
  const pick = (prompt: string, value: string) =>
    fill(multi && prompt ? `${prompt}：${value}` : value);

  return (
    <DecisionCard tone="primary" animate className="overflow-hidden p-0">
      <div className="space-y-3 px-3 pb-3 pt-3">
        <div className="flex items-start gap-2">
          <DecisionCardIcon tone="primary">
            <CircleHelp size={16} />
          </DecisionCardIcon>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-primary">
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

        {ask.assumptions.length > 0 && (
          <div className="rounded-lg border-l-2 border-primary/30 bg-muted/40 px-3 py-2">
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
                      <Button
                        key={opt}
                        variant="neutral"
                        className="h-auto border border-border bg-card py-1 text-muted-foreground hover:border-primary/40"
                        onClick={() => pick(q.prompt, opt)}
                      >
                        <span className="whitespace-pre-wrap">{opt}</span>
                        {isDefault && (
                          <Badge tone="muted" pill className="ml-1">
                            默认
                          </Badge>
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
                variant="neutral"
                className="border border-border bg-card text-muted-foreground hover:border-primary/40"
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
