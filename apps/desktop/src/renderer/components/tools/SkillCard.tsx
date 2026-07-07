import { PromptDocument } from "@/components/prompt/PromptDocument";
import { Button, CatalogIconShell } from "@/components/ui";
import { catalogCategoryColorVar } from "@/lib/catalogColors";
import type { CapabilitySkill } from "@/services/capabilities";
import { BookOpen, ChevronRight } from "lucide-react";
import { useState } from "react";

/** One Skill tile: catalog summary, click-to-expand the full guidance body via
 * {@link PromptDocument}. */
export function SkillCard({
  skill,
  disabled,
  disabledHint,
}: {
  skill: CapabilitySkill;
  disabled?: boolean;
  disabledHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const skillColor = catalogCategoryColorVar("skill");
  return (
    <div
      className={`flex flex-col rounded-xl border border-border bg-card p-4 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      <Button
        variant="ghost"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className="h-auto w-full items-start gap-2 p-0 text-left font-normal"
      >
        <CatalogIconShell
          colorVar={skillColor}
          className="mt-0.5 size-8 rounded-lg"
        >
          <BookOpen size={14} />
        </CatalogIconShell>
        <div className="min-w-0 flex-1">
          <span className="block font-mono text-foreground text-sm">
            {skill.name}
          </span>
          <span className="mt-0.5 block text-muted-foreground text-xs">
            {skill.summary}
          </span>
        </div>
        <ChevronRight
          size={14}
          className={`mt-0.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
      </Button>
      {disabled && disabledHint && (
        <p className="mt-2 text-xs text-muted-foreground">{disabledHint}</p>
      )}
      {open && (
        <PromptDocument
          text={skill.body}
          className="mt-2"
          maxHeightClass="max-h-96"
        />
      )}
    </div>
  );
}
