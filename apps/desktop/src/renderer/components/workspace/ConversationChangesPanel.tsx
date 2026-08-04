import { TurnFileChangesReview } from "@/components/chat/TurnFileChangesReview";
import { EmptyHint } from "@/components/files/parts";
import { GitChangesSection } from "@/components/workspace/GitChangesSection";
import { useWorkspaceModeState } from "@/components/workspace/WorkspaceModeControl";
import { useGitRepoStatus } from "@/hooks/useGitRepoStatus";
import { useLocalTurnBaselineIds } from "@/hooks/useLocalTurnBaselineIds";
import { useConversationWorkspace } from "@/hooks/useWorkspaces";
import { hasLocalFiles } from "@/lib/capabilities";
import { shouldIncludeChangesTurn } from "@/lib/conversationFileChanges";
import {
  type FileArtifact,
  fileArtifactsFromExecution,
  fileArtifactsFromProcess,
  mergeArtifacts,
} from "@/lib/fileArtifacts";
import { gitTrackHasWork } from "@/lib/gitRepoStatus";
import { useConversationStore } from "@/stores/conversation";
import {
  assistantProjectionId,
  runtimeOf,
} from "@/stores/conversation/runtime";
import { projectRuntime, useExecutionStore } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { Diff } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

/**
 * 右坞条件「改动」tab 体 —— 双轨：Git SCM（U2/U3）∥ 回合 zip 回滚（P0c）。
 * 顶栏有改动记录、Local zip 基线、Git 有货或深链才挂本面板。
 */

interface TurnChanges {
  messageId: string;
  label: string;
  artifacts: FileArtifact[];
}

export function ConversationChangesPanel() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const messages = useConversationStore(
    (s) => runtimeOf(s, conversationId).messages,
  );
  const byId = useExecutionStore((s) => s.byId);
  const focusMessageId = useSidePanelStore((s) => s.changesFocusMessageId);
  const baselineMessageIds = useLocalTurnBaselineIds(conversationId, messages);

  const wsState = useWorkspaceModeState(conversationId);
  const convWs = useConversationWorkspace(conversationId);
  const canGit =
    hasLocalFiles() &&
    !!wsState?.effective.isLocal &&
    !!wsState.effective.rootId &&
    !wsState.effective.rootMissing;
  const rootId = canGit ? (wsState?.effective.rootId ?? null) : null;
  // FileDetail / createLocalRootSource 期望 workspace 相对路径；git 仍在仓根跑。
  const workspaceSubpath = convWs?.subpath ?? "";
  const { status: gitStatus, refresh: refreshGit } = useGitRepoStatus(
    rootId,
    canGit,
  );
  const showGitTrack = gitTrackHasWork(gitStatus);

  const turns = useMemo((): TurnChanges[] => {
    const out: TurnChanges[] = [];
    let turnIndex = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      turnIndex += 1;
      const messageId = assistantProjectionId(msg);
      const rt = byId[messageId];
      const execution = rt ? projectRuntime(rt) : null;
      const artifacts = mergeArtifacts(
        fileArtifactsFromProcess(msg.process),
        fileArtifactsFromExecution(execution),
      );
      if (
        !shouldIncludeChangesTurn({
          artifactsLength: artifacts.length,
          messageId,
          baselineMessageIds,
          focusMessageId,
        })
      ) {
        continue;
      }
      out.push({
        messageId,
        label: `回合 ${turnIndex}`,
        artifacts,
      });
    }
    // 聚焦回合尚未出现在 messages（极端时序）时仍给一个入口。
    if (focusMessageId && !out.some((t) => t.messageId === focusMessageId)) {
      out.push({
        messageId: focusMessageId,
        label: "本回合",
        artifacts: [],
      });
    }
    return out;
  }, [messages, byId, focusMessageId, baselineMessageIds]);

  const focusRef = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: turns is an intentional re-run key after list lands
  useEffect(() => {
    if (!focusMessageId) return;
    focusRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusMessageId, turns]);

  if (!conversationId) {
    return (
      <EmptyHint
        inline
        icon={<Diff size={26} className="text-muted-foreground/40" />}
        title="暂无改动"
        hint="发送消息后，本对话 AI 写入工作区的文件改动或可恢复基线会出现在这里。"
      />
    );
  }

  if (turns.length === 0 && !showGitTrack) {
    return (
      <EmptyHint
        inline
        icon={<Diff size={26} className="text-muted-foreground/40" />}
        title="暂无改动"
        hint="本对话尚无 AI 文件改动、可恢复的回合基线，或 Git 未提交变更。产物卡「查看改动」与此处同源。"
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="space-y-4">
        {showGitTrack && rootId && gitStatus ? (
          <GitChangesSection
            rootId={rootId}
            status={gitStatus}
            onRefresh={() => void refreshGit()}
            subpath={workspaceSubpath}
          />
        ) : null}

        {turns.length > 0 ? (
          <div className="space-y-4" data-testid="zip-changes-track">
            {showGitTrack ? (
              <p className="px-0.5 text-xs text-muted-foreground">
                回合改动（zip 基线回滚 · 与 Git 正交）
              </p>
            ) : null}
            {turns.map((t) => {
              const focused = t.messageId === focusMessageId;
              return (
                <section
                  key={t.messageId}
                  ref={focused ? focusRef : undefined}
                  className={`rounded-xl border border-border bg-card ${
                    focused ? "ring-1 ring-primary/40" : ""
                  }`}
                >
                  <header className="border-b border-border px-3 py-2">
                    <h3 className="text-xs font-medium text-muted-foreground">
                      {t.label}
                      {t.artifacts.length > 0 && (
                        <span className="ml-2 tabular-nums text-muted-foreground/80">
                          {t.artifacts.length} 个文件
                        </span>
                      )}
                    </h3>
                  </header>
                  <TurnFileChangesReview
                    artifacts={t.artifacts}
                    conversationId={conversationId}
                    messageId={t.messageId}
                    variant="panel"
                  />
                </section>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
