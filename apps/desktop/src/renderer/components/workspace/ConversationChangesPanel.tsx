import { TurnFileChangesReview } from "@/components/chat/TurnFileChangesReview";
import { EmptyHint } from "@/components/files/parts";
import { Button } from "@/components/ui";
import { ChangesVersionEntry } from "@/components/workspace/ChangesVersionEntry";
import { GitChangesSection } from "@/components/workspace/GitChangesSection";
import { KeepVersionAction } from "@/components/workspace/KeepVersionAction";
import { useWorkspaceModeState } from "@/components/workspace/WorkspaceModeControl";
import {
  type TurnTimelineEntry,
  type VersionSource,
  mergeChangesTimeline,
} from "@/components/workspace/changesTimeline";
import { useChangesVersions } from "@/components/workspace/useChangesVersions";
import { useGitRepoStatus } from "@/hooks/useGitRepoStatus";
import { useLocalTurnBaselineIds } from "@/hooks/useLocalTurnBaselineIds";
import { useConversationWorkspace } from "@/hooks/useWorkspaces";
import { hasLocalFiles } from "@/lib/capabilities";
import { shouldIncludeChangesTurn } from "@/lib/conversationFileChanges";
import {
  fileArtifactsFromExecution,
  fileArtifactsFromProcess,
  mergeArtifacts,
} from "@/lib/fileArtifacts";
import { formatMessageTime } from "@/lib/format";
import { gitTrackHasWork } from "@/lib/gitRepoStatus";
import { queryClient } from "@/lib/queryClient";
import { workspaceKeys } from "@/lib/queryKeys";
import { useAutoSnapshotStore } from "@/stores/autoSnapshot";
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
 * 右坞常驻「改动」tab 体 —— 双轨：Git SCM（U2/U3）∥ zip 时间轴。
 * tab 一直在（空态由本面板自己如实说明），深链只决定聚焦哪个回合。
 *
 * zip 轨是**一条**倒序时间轴：回合改动、用户留存版本、交接存档穿插在一起——
 * 「改动」与「版本」本就是同一个功能，用户要的是「什么时候变成什么样、怎么回去」。
 * 云端工作区的版本走快照 API、本机工作区的走盘上版本区，在轨上是同一种条目
 * （见 `changesTimeline.ts`）。自动备份与回合基线不单列（回合条目已代表那个时间点）。
 */

/** 版本轨没拉到时的诚实兜底：别让「暂无改动」冒充「确实没有版本」。 */
function VersionsUnavailableNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>版本没能加载出来，这里只有本对话的回合改动。</span>
      <Button variant="ghost" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

/**
 * 回合后自动备份失败的横幅 —— SSE 只翻 `useAutoSnapshotStore` 的位，这里是它唯一的
 * UI 出口（原挂在已下线的快照面板顶部）。回合本身是成功的，所以是提醒不是报错。
 */
function AutoBackupFailedNotice({
  conversationId,
}: { conversationId: string }) {
  const failed = useAutoSnapshotStore((s) =>
    Boolean(s.failedByConversation[conversationId]),
  );
  if (!failed) return null;
  return (
    <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      最近一次自动备份失败。回合已正常完成；可手动留版本，或等下次改文件回合重试。
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

  // 版本住在哪由工作区决定：云端走快照 API，本机走盘上版本区（与回合基线同一个内部区）。
  const isLocalWorkspace =
    convWs?.location === "local" || !!wsState?.effective.isLocal;
  const localVersionRootId =
    convWs?.location === "local" ? convWs.rootId : null;
  const versionSource = useMemo<VersionSource | null>(() => {
    if (!conversationId) return null;
    if (!isLocalWorkspace) return { origin: "cloud", conversationId };
    // 够不到盘（web 运行时 / 根还没解析出来）就没有版本轨，别拿云端快照冒充本机版本。
    if (!hasLocalFiles() || !localVersionRootId) return null;
    return {
      origin: "local",
      target: { rootId: localVersionRootId, subpath: workspaceSubpath },
    };
  }, [conversationId, isLocalWorkspace, localVersionRootId, workspaceSubpath]);
  const {
    entries: versions,
    failed: versionsFailed,
    reload: reloadVersions,
  } = useChangesVersions(versionSource);
  // 项目工作区（folder:*）下各会话共用一份版本历史（云端按存储键、本机按盘上目录），要标注共享。
  const versionsShared = (convWs?.wsId ?? "").startsWith("folder:");

  const turns = useMemo((): TurnTimelineEntry[] => {
    const out: TurnTimelineEntry[] = [];
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
        kind: "turn",
        id: messageId,
        messageId,
        label: `回合 ${turnIndex}`,
        artifacts,
        at: msg.createdAt,
      });
    }
    // 聚焦回合尚未出现在 messages（极端时序）时仍给一个入口。
    if (focusMessageId && !out.some((t) => t.messageId === focusMessageId)) {
      out.push({
        kind: "turn",
        id: focusMessageId,
        messageId: focusMessageId,
        label: "本回合",
        artifacts: [],
        at: new Date().toISOString(),
      });
    }
    return out;
  }, [messages, byId, focusMessageId, baselineMessageIds]);

  const timeline = useMemo(
    () => mergeChangesTimeline(turns, versions),
    [turns, versions],
  );

  const focusRef = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: timeline is an intentional re-run key after list lands
  useEffect(() => {
    if (!focusMessageId) return;
    focusRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusMessageId, timeline]);

  // 有 AI 文件改动时刷新工作区轨，避免中枢仍藏着尚未列出的 conv scratch（与列表对齐）。
  useEffect(() => {
    if (turns.some((t) => t.artifacts.length > 0)) {
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
    }
  }, [turns]);

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

  if (timeline.length === 0 && !showGitTrack) {
    return (
      <div className="flex h-full flex-col">
        <AutoBackupFailedNotice conversationId={conversationId} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Diff size={26} className="text-muted-foreground/40" />
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">暂无改动</p>
            <p className="text-xs text-muted-foreground">
              {versionSource
                ? "可为当前工作区留一个版本，之后随时回到这里。"
                : "本对话尚无 AI 文件改动，也没有可恢复的回合基线。"}
            </p>
          </div>
          {versionSource ? (
            <KeepVersionAction
              emphasis
              source={versionSource}
              onCreated={() => void reloadVersions()}
            />
          ) : null}
          {versionsFailed ? (
            <VersionsUnavailableNotice onRetry={() => void reloadVersions()} />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <AutoBackupFailedNotice conversationId={conversationId} />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {showGitTrack && rootId && gitStatus ? (
          <GitChangesSection
            rootId={rootId}
            status={gitStatus}
            onRefresh={() => void refreshGit()}
            subpath={workspaceSubpath}
          />
        ) : null}

        <div className="space-y-3" data-testid="changes-timeline">
          {showGitTrack ? (
            <p className="px-0.5 text-xs text-muted-foreground">
              改动与版本（zip 轨 · 与 Git 正交）
            </p>
          ) : null}

          {versionSource ? (
            <div className="flex justify-end">
              <KeepVersionAction
                source={versionSource}
                onCreated={() => void reloadVersions()}
              />
            </div>
          ) : null}

          {versionsFailed ? (
            <VersionsUnavailableNotice onRetry={() => void reloadVersions()} />
          ) : null}

          {timeline.map((entry) => {
            if (entry.kind !== "turn") {
              return versionSource ? (
                <ChangesVersionEntry
                  key={entry.id}
                  source={versionSource}
                  entry={entry}
                  shared={versionsShared}
                  onChanged={() => void reloadVersions()}
                />
              ) : null;
            }
            const focused = entry.messageId === focusMessageId;
            return (
              <section
                key={entry.id}
                ref={focused ? focusRef : undefined}
                data-testid="changes-timeline-entry"
                data-entry-kind="turn"
                data-entry-id={entry.id}
                className={`rounded-xl border border-border bg-card ${
                  focused ? "ring-1 ring-primary/40" : ""
                }`}
              >
                <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                  <Diff size={13} className="shrink-0 text-muted-foreground" />
                  <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                    {entry.label}
                    {entry.artifacts.length > 0 && (
                      <span className="ml-2 tabular-nums text-muted-foreground/80">
                        {entry.artifacts.length} 个文件
                      </span>
                    )}
                  </h3>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatMessageTime(entry.at)}
                  </span>
                </header>
                <TurnFileChangesReview
                  artifacts={entry.artifacts}
                  conversationId={conversationId}
                  messageId={entry.messageId}
                  variant="panel"
                />
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
