import { resumeDeferredCardCopy } from "@/lib/resumeDeferred";
import type { ResumeDeferredBusyReason } from "@/lib/resumeDeferred";

/** Inline notice on cold ResumePrompt while deferred wait is in flight. */
export function ResumeDeferredNotice({
  busyReason,
}: {
  busyReason: ResumeDeferredBusyReason;
}) {
  return (
    <p
      className="text-xs leading-relaxed text-muted-foreground"
      data-testid="resume-deferred-notice"
    >
      {resumeDeferredCardCopy(busyReason)}
    </p>
  );
}
