/**
 * Fixed local-picker failure card (B4 / aa51904b).
 * Replaces free-form 「已触发请选择」空转 with a structured title + detail.
 */
import {
  type LocalPickerFailureKind,
  localPickerFailureCopy,
} from "@/lib/bindLocalFolder";
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
      className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      data-testid="local-picker-failure-card"
      data-failure-kind={kind}
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0 space-y-0.5">
        <span className="block font-medium text-destructive">{title}</span>
        <span className="block text-destructive/90">{detail}</span>
      </span>
    </output>
  );
}
