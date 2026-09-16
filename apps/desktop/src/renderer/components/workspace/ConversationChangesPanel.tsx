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
import { formatMessageTime } from "@/lib/format";
import { gitTrackHasWork } from "@/lib/gitRepoStatus";
import { useAutoSnapshotStore } from "@/stores/autoSnapshot";
import { useConversationStore } from "@/stores/conversation";
import {
  assistantProjectionId,
  runtimeOf,
} from "@/stores/conversation/runtime";
import { projectRuntime, useExecutionStore } from "@/stores/execution";
import { useSidePanelStore } from "@/stores/sidePanel";
import { Diff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 右坞「改动」tab —— 上：这次对话动过的文件；下：这个文件夹的 Git。
 * Git 只认当前文件夹根下 `.git`。干净（无脏 / 冲突 / 领先落后）不占下面。
 * 零文件差异的回合不列出、不挂恢复。
 * 只读 process / execution，不为「出现产物」invalidate 工作区列表或换 FileSource。
 */

interface TurnEntry {
  id: string;
  messageId: string;
  label: string;
  artifacts: FileArtifact[];
  at: string;
}

function AutoBackupFailedNotice({
  conversationId,
}: { conversationId: string }) {
  const failed = useAutoSnapshotStore((s) =>
    Boolean(s.failedByConversation[conversationId]),
  );
  if (!failed) return null;
  return (
    <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      最近一次自动备份失败。回合已正常完成，下次改文件的回合会再试。
    </div>
  );
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
    !!convWs &&
    !!wsState?.effective.isLocal &&
    !!wsState.effective.rootId &&
    !wsState.effective.rootMissing;
  const rootId = canGit ? (wsState?.effective.rootId ?? null) : null;
  const workspaceSubpath = convWs?.subpath ?? "";
  const { status: gitStatus, refresh: refreshGit } = useGitRepoStatus(
    rootId,
    canGit,
    workspaceSubpath,
  );
  const showGitTrack = gitTrackHasWork(gitStatus);

  const [turnHasChanges, setTurnHasChanges] = useState<Record<string, boolean>>(
    {},
  );
  const [turnProbeConvId, setTurnProbeConvId] = useState(conversationId);
  if (conversationId !== turnProbeConvId) {
    setTurnProbeConvId(conversationId);
    setTurnHasChanges({});
  }

  const reportHasChanges = useCallback((id: string, has: boolean) => {
    setTurnHasChanges((prev) =>
      prev[id] === has ? prev : { ...prev, [id]: has },
    );
  }, []);

  const turns = useMemo((): TurnEntry[] => {
    const out: TurnEntry[] = [];
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
        id: messageId,
        messageId,
        label: `回合 ${turnIndex}`,
        artifacts,
        at: msg.createdAt,
      });
    }
    if (focusMessageId && !out.some((t) => t.messageId === focusMessageId)) {
      out.push({
        id: focusMessageId,
        messageId: focusMessageId,
        label: "本回合",
        artifacts: [],
        at: new Date().toISOString(),
      });
    }
    return out;
  }, [messages, byId, focusMessageId, baselineMessageIds]);

  const timeline = useMemo(() => [...turns].reverse(), [turns]);

  const probingEmptyTurns = timeline.some(
    (t) => t.artifacts.length === 0 && turnHasChanges[t.id] === undefined,
  );
  const anyTurnShown = timeline.some(
    (t) => t.artifacts.length > 0 || turnHasChanges[t.id] === true,
  );

  const focusRef = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: timeline is an intentional re-run key after list lands
  useEffect(() => {
    if (!focusMessageId) return;
    focusRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusMessageId, timeline]);

  if (!conversationId) {
    return (
      <EmptyHint
        inline
        icon={<Diff size={26} className="text-muted-foreground/40" />}
        title="暂无改动"
      />
    );
  }

  if (!probingEmptyTurns && !anyTurnShown && !showGitTrack) {
    return (
      <div className="flex h-full flex-col">
        <AutoBackupFailedNotice conversationId={conversationId} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Diff size={26} className="text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">暂无改动</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <AutoBackupFailedNotice conversationId={conversationId} />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <div className="space-y-3" data-testid="changes-timeline">
          {anyTurnShown && showGitTrack ? (
            <p className="px-0.5 text-xs text-muted-foreground">这次对话</p>
          ) : null}

          {timeline.map((entry) => {
            const focused = entry.messageId === focusMessageId;
            return (
              <TurnFileChangesReview
                key={entry.id}
                artifacts={entry.artifacts}
                conversationId={conversationId}
                messageId={entry.messageId}
                variant="panel"
                heading={entry.label}
                headingTime={formatMessageTime(entry.at)}
                focused={focused}
                sectionRef={focused ? focusRef : undefined}
                onHasChanges={(has) => reportHasChanges(entry.id, has)}
              />
            );
          })}
        </div>

        {showGitTrack && rootId && gitStatus ? (
          <GitChangesSection
            rootId={rootId}
            status={gitStatus}
            onRefresh={() => void refreshGit()}
            subpath={workspaceSubpath}
          />
        ) : null}
      </div>
    </div>
  );
}
