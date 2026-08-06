/**
 * Fixed local-picker failure card (B4 / aa51904b).
 * Replaces free-form 「已触发请选择」空转 / 灰掉无解释 with structured title + detail.
 */
import {
  type LocalPickerFailureKind,
  localPickerFailureCopy,
} from "@/lib/localPickerFailure";

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
      className="local-picker-failure-card"
      data-testid="local-picker-failure-card"
      data-failure-kind={kind}
    >
      <span className="local-picker-failure-title">{title}</span>
      <span className="local-picker-failure-detail">{detail}</span>
    </output>
  );
}
