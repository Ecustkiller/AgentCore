import { Button, IconButton } from "@/components/ui";
import {
  useActiveError,
  useActiveErrorAction,
  useActiveRetry,
  useConversationStore,
} from "@/stores/conversation";
import { AlertTriangle, KeyRound, RotateCw, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * Banner for a failed turn (send / regenerate transport error). Shown just above
 * the input in chat ({@link import("./ChatView")}) and in the canvas 指挥台
 * ({@link import("../graph/CanvasDecisionPanel")}, 前端UX设计.md §6.2) — in canvas
 * mode ChatView is unmounted, so without it a transport failure would be
 * invisible / unretriable there. The retry closure re-runs that exact turn; the
 * optional action routes the user to fix the cause (e.g. "去配置" → model config
 * for a missing BYOK key); dismissing only hides the banner.
 *
 * Conversation-scoped (reads the active conversation's error state) and therefore
 * self-contained wherever it mounts — mirrors {@link import("./ApprovalPrompt").ApprovalPrompt}
 * / {@link import("./ResumePrompt").ResumePrompt}.
 */
export function RetryBanner() {
  const error = useActiveError();
  const retry = useActiveRetry();
  const action = useActiveErrorAction();
  const clearError = useConversationStore((s) => s.clearError);
  const navigate = useNavigate();
  if (!error) return null;

  return (
    <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertTriangle size={15} className="shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
      {action && (
        <Button
          variant="destructive"
          className="shrink-0"
          icon={<KeyRound size={13} />}
          onClick={() => {
            clearError();
            navigate(action.href);
          }}
        >
          {action.label}
        </Button>
      )}
      {retry && (
        <Button
          variant="destructive"
          className="shrink-0"
          icon={<RotateCw size={13} />}
          onClick={() => retry()}
        >
          重试
        </Button>
      )}
      <IconButton
        onClick={() => clearError()}
        aria-label="关闭"
        className="text-destructive/70 hover:bg-transparent hover:text-destructive"
      >
        <X size={14} />
      </IconButton>
    </div>
  );
}
