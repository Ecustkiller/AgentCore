import { useWorkspaceModeState } from "@/components/workspace/WorkspaceModeControl";
import { useGitRepoStatus } from "@/hooks/useGitRepoStatus";
import { hasLocalFiles } from "@/lib/capabilities";
import { GitBranch } from "lucide-react";

/**
 * U1 会话条只读 Git chip：分支名 + dirty 点（有仓才显）。
 * 与「改动」zip∥git 双轨正交；stage/commit/push 在「改动」tab（U3）。
 */
export function ComposerGitStatusChip({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const state = useWorkspaceModeState(conversationId);
  const canProbe =
    hasLocalFiles() &&
    !!state?.effective.isLocal &&
    !!state.effective.rootId &&
    !state.effective.rootMissing;

  const { status } = useGitRepoStatus(
    canProbe ? state?.effective.rootId : null,
    canProbe,
  );

  if (!status) return null;

  const title = status.dirty
    ? `${status.branch} · 工作区有未提交改动`
    : status.branch;

  return (
    <span
      className="inline-flex h-7 max-w-[140px] shrink items-center gap-1 px-1.5 text-xs text-muted-foreground"
      title={title}
      aria-label={title}
      data-testid="composer-git-status-chip"
    >
      <GitBranch size={12} className="shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{status.branch}</span>
      {status.dirty ? (
        <span
          className="inline-block size-1.5 shrink-0 rounded-full bg-warning"
          aria-label="有未提交改动"
        />
      ) : null}
    </span>
  );
}
