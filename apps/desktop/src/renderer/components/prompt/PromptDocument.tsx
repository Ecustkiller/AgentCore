import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui";
import {
  hasTaggedSections,
  parsePromptDocument,
} from "@/lib/parsePromptDocument";
import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";

type ViewMode = "render" | "source";

/** Structured prompt / skill body: tagged sections rendered as Markdown, with a
 * source toggle for verbatim copy. Shared by 工具箱能力图鉴, 收到的上下文, and
 * consult_skill result cards. */
export function PromptDocument({
  text,
  className,
  maxHeightClass = "max-h-[32rem]",
}: {
  text: string;
  className?: string;
  /** Tailwind max-height utility for the scroll container. */
  maxHeightClass?: string;
}) {
  const sections = useMemo(() => parsePromptDocument(text), [text]);
  const structured = hasTaggedSections(sections);
  const [mode, setMode] = useState<ViewMode>("render");

  if (!text.trim()) return null;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-end gap-1">
        <Button
          variant={mode === "render" ? "neutral" : "ghost"}
          size="sm"
          onClick={() => setMode("render")}
          className={mode === "render" ? "border-border" : undefined}
        >
          渲染
        </Button>
        <Button
          variant={mode === "source" ? "neutral" : "ghost"}
          size="sm"
          onClick={() => setMode("source")}
          className={mode === "source" ? "border-border" : undefined}
        >
          原文
        </Button>
      </div>

      {mode === "source" ? (
        <pre
          className={cn(
            "overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-3 py-2 text-foreground/90 text-xs leading-relaxed",
            maxHeightClass,
          )}
        >
          {text}
        </pre>
      ) : structured ? (
        <div
          className={cn(
            "space-y-3 overflow-auto rounded-lg bg-muted/50 px-3 py-2",
            maxHeightClass,
          )}
        >
          {sections.map((section, i) => (
            <section
              key={`${section.tag ?? "preamble"}-${i}`}
              className="space-y-1"
            >
              {section.title ? (
                <h3 className="font-medium text-foreground text-xs">
                  {section.title}
                </h3>
              ) : null}
              <div className="markdown-body markdown-body--compact text-foreground/90">
                <Markdown content={section.body} muted />
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div
          className={cn(
            "overflow-auto rounded-lg bg-muted/50 px-3 py-2 markdown-body markdown-body--compact text-foreground/90",
            maxHeightClass,
          )}
        >
          <Markdown content={text} muted />
        </div>
      )}
    </div>
  );
}
