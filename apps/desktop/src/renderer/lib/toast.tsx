import { describeError } from "@/lib/errors";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

// Token-colored leading icons (the toast surface itself stays neutral popover —
// see components/ui/Toaster). The icon carries the status color, matching how the
// app signals state with icons elsewhere (color-tokens).
const errorIcon = <AlertTriangle size={16} className="text-destructive" />;
const successIcon = <CheckCircle2 size={16} className="text-success" />;
const warningIcon = <AlertTriangle size={16} className="text-warning" />;

/**
 * Surface any caught error as a toast, phrased by the shared error map
 * (lib/errors) so a REST failure reads the same as an SSE-turn failure. A no-op
 * for errors handled elsewhere (auth → the login redirect), so callers can pass
 * anything they caught without pre-filtering.
 *
 * - Pass a plain string to show a client-side message verbatim (e.g. input
 *   validation that never hit the server).
 * - Pass `context` to title the toast (e.g. "重命名失败") with the backend's
 *   resolved detail as the description; omit it to show the detail as the title.
 * - An error whose code maps to a remedy (e.g. a missing key → 去配置) gets a
 *   one-click action button that navigates there.
 */
export function notifyError(err: unknown, context?: string): void {
  if (typeof err === "string") {
    toast.error(err, { icon: errorIcon });
    return;
  }
  const described = describeError(err);
  if (!described) return; // auth etc. — the redirect already handles it
  const action = described.action;
  toast.error(context ?? described.message, {
    description: context ? described.message : undefined,
    icon: errorIcon,
    action: action
      ? {
          label: action.label,
          // Hash-router navigation from non-component code: setting the hash
          // drives createHashRouter exactly like a <Link> click.
          onClick: () => {
            window.location.hash = action.href;
          },
        }
      : undefined,
  });
}

/** A success toast for a completed user action (e.g. a snapshot was created). */
export function notifySuccess(message: string): void {
  toast.success(message, { icon: successIcon });
}

/**
 * A non-blocking warning toast with an optional one-click action.
 *
 * Distinct from {@link notifyError}: the user's primary action SUCCEEDED, this just
 * flags a degraded side-effect they can act on (e.g. a best-effort write-back that
 * failed and can be retried). Amber icon on the neutral surface (color-tokens), so it
 * reads as "heads up", not "failed". The action is caller-supplied (not the error map).
 */
export function notifyWarning(
  message: string,
  opts?: {
    description?: string;
    action?: { label: string; onClick: () => void };
  },
): void {
  toast.warning(message, {
    description: opts?.description,
    icon: warningIcon,
    action: opts?.action,
  });
}
