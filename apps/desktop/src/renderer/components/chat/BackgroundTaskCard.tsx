import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  PatternCardHeader,
} from "@/components/ui";
import { statusCardChrome } from "@/components/ui/tone-presets";
import { ApiError } from "@/services/api";
import {
  type HandoffCardPhase,
  type HandoffJob,
  discardHandoffJob,
  resolveHandoffCardPhase,
} from "@/services/handoff";
import {
  useBackgroundTaskMerged,
  useBackgroundTasksStore,
} from "@/stores/backgroundTasks";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  GitPullRequest,
  Loader2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { BackgroundTaskReview } from "./BackgroundTaskReview";
import { Markdown } from "./Markdown";

export function BackgroundTaskCard({
  job,
  rootId,
}: {
  job: HandoffJob;
  rootId: string | null;
}) {
  const merged = useBackgroundTaskMerged(job.id);
  const phase = resolveHandoffCardPhase(job, merged);
  const meta = statusMeta(phase);

  return (
    <Card
      className={`animate-task-card-enter p-3 ${meta.border} ${meta.surface}`}
    >
      <PatternCardHeader
        icon={<Cloud size={16} />}
        iconClassName={meta.accent}
        label="后台云端任务"
        labelClassName={meta.accent}
        badge={<StatusBadge phase={phase} />}
        trailing={formatWhen(job.createdAt)}
      />
      <div className="mt-1 break-words">
        <Markdown content={job.task} />
      </div>
      <Body job={job} rootId={rootId} phase={phase} />
    </Card>
  );
}

function Body({
  job,
  rootId,
  phase,
}: {
  job: HandoffJob;
  rootId: string | null;
  phase: HandoffCardPhase;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const markMerged = useBackgroundTasksStore((s) => s.markMerged);
  const upsert = useBackgroundTasksStore((s) => s.upsert);

  if (phase === "pending") {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">
        正在把本机文件打成云端拷贝并派发…超大仓库可能拷不全，不会假装已完整同步。
      </p>
    );
  }
  if (phase === "running") {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">
        AI
        正在云端拷贝上改动，不会直接改你本机文件夹。完成后需你点一下才合回本机。
      </p>
    );
  }
  if (phase === "failed") {
    return (
      <p className="mt-1.5 text-xs text-destructive">
        {formatHandoffFailure(job.error)}
      </p>
    );
  }
  if (phase === "discarded") {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">
        已放弃这份云端结果，没有写入本机文件夹。
      </p>
    );
  }
  if (phase === "applied" && !reviewing) {
    return (
      <div className="mt-2 space-y-1.5">
        <p className="text-xs text-muted-foreground">
          已合回本机（或确认无需合回）。
        </p>
        {rootId ? (
          <Button
            variant="neutral"
            className="border border-border"
            icon={<GitPullRequest size={13} />}
            onClick={() => setReviewing(true)}
          >
            再次查看改动
          </Button>
        ) : null}
      </div>
    );
  }

  if (reviewing && rootId) {
    return (
      <BackgroundTaskReview
        conversationId={job.sourceConversationId}
        jobId={job.id}
        rootId={rootId}
        onClose={() => setReviewing(false)}
        onMerged={() => {
          markMerged(job.id);
          // 乐观对齐后端 applied，避免合回后仍闪「待合回」。
          upsert(job.sourceConversationId, { ...job, status: "applied" });
        }}
      />
    );
  }

  // awaiting（succeeded + 未合回）
  const onDiscard = async () => {
    if (discarding) return;
    setDiscarding(true);
    setDiscardError(null);
    try {
      const next = await discardHandoffJob(job.sourceConversationId, job.id);
      upsert(job.sourceConversationId, next);
    } catch (err) {
      setDiscardError(
        err instanceof ApiError
          ? (err.serverMessage ?? "放弃失败，请稍后重试")
          : err instanceof Error
            ? err.message
            : "放弃失败，请稍后重试",
      );
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <div className="mt-2 space-y-1.5">
      <p className="text-xs text-muted-foreground">
        {rootId
          ? "云端拷贝已改完，尚未写入本机文件夹。"
          : "云端拷贝已改完 · 切回本地模式后可在此查看改动并合回本机。也可直接放弃这份结果。"}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {rootId ? (
          <Button
            variant="neutral"
            className="border border-border"
            icon={<GitPullRequest size={13} />}
            onClick={() => setReviewing(true)}
          >
            查看改动并合回本机
          </Button>
        ) : null}
        <Button
          variant="neutral"
          className="border border-border"
          icon={
            discarding ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <XCircle size={13} />
            )
          }
          disabled={discarding}
          onClick={() => void onDiscard()}
        >
          放弃结果
        </Button>
      </div>
      {discardError ? (
        <p className="text-xs text-destructive">{discardError}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          放弃＝不把云端改动写入本机，并丢掉这份云端拷贝结果。
        </p>
      )}
    </div>
  );
}

function StatusBadge({ phase }: { phase: HandoffCardPhase }) {
  const meta = statusMeta(phase);
  const tone: BadgeTone =
    phase === "running"
      ? "primary"
      : phase === "awaiting"
        ? "success"
        : phase === "failed"
          ? "destructive"
          : "muted";

  return (
    <Badge tone={tone} className="inline-flex items-center gap-1 font-medium">
      {meta.spin ? <Loader2 size={11} className="animate-spin" /> : meta.icon}
      {meta.label}
    </Badge>
  );
}

type StatusChrome = {
  label: string;
  accent: string;
  border: string;
  surface: string;
  spin: boolean;
  icon: React.ReactNode;
};

function statusMeta(phase: HandoffCardPhase): StatusChrome {
  if (phase === "pending") {
    return {
      label: "派发中",
      ...statusCardChrome("muted"),
      spin: true,
      icon: null,
    };
  }
  if (phase === "running") {
    return {
      label: "改拷贝中",
      ...statusCardChrome("primary"),
      spin: true,
      icon: null,
    };
  }
  if (phase === "failed") {
    return {
      label: "失败",
      ...statusCardChrome("destructive"),
      spin: false,
      icon: <AlertTriangle size={11} />,
    };
  }
  if (phase === "discarded") {
    return {
      label: "已丢弃",
      ...statusCardChrome("muted"),
      spin: false,
      icon: <XCircle size={11} />,
    };
  }
  if (phase === "applied") {
    return {
      label: "已合回本机",
      ...statusCardChrome("muted"),
      spin: false,
      icon: <CheckCircle2 size={11} />,
    };
  }
  return {
    label: "待合回本机",
    ...statusCardChrome("success"),
    spin: false,
    icon: <CheckCircle2 size={11} />,
  };
}

/** 失败文案：大仓截断 / 打包失败诚实说拷不全，勿承诺完美同步。 */
function formatHandoffFailure(error: string | null): string {
  if (!error) return "任务失败";
  const lower = error.toLowerCase();
  if (
    lower.includes("truncat") ||
    lower.includes("max_files") ||
    lower.includes("max_bytes") ||
    lower.includes("archive limit") ||
    error.includes("过大") ||
    error.includes("截断") ||
    error.includes("拷不全")
  ) {
    return `失败：仓库过大或打包受限，云端拷贝可能不全——${error}`;
  }
  return `失败：${error}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
