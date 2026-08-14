/**
 * Fixed local-picker failure card (B4 / aa51904b).
 * Replaces free-form 「已触发请选择」空转 with a structured title + detail.
 * Tone: recoverable interruption → {@link noticeChipNeutral} (not danger red).
 */
import { noticeChipNeutral } from "@/components/ui/tone-presets";
import {
  type LocalPickerFailureKind,
  localPickerFailureCopy,
} from "@/lib/bindLocalFolder";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";

export function LocalPickerFailureCard({
  kind,
  message,
}: {
  kind: LocalPickerFailureKind;
  message?: string;
}) {
  const { title, detail } = localPickerFailureCopy(kind, message);
  return (
    <output
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        noticeChipNeutral,
      )}
      data-testid="local-picker-failure-card"
      data-failure-kind={kind}
    >
      <AlertTriangle
        size={14}
        className="mt-0.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 space-y-0.5">
        <span className="block font-medium">{title}</span>
        <span className="block">{detail}</span>
      </span>
    </output>
  );
}
