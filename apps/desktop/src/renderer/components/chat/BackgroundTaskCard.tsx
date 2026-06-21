import type { HandoffJob } from "@/services/handoff";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  GitPullRequest,
  Loader2,
} from "lucide-react";
import { useState } from "react";
import { BackgroundTaskReview } from "./BackgroundTaskReview";

/**
 * 后台云端任务卡（双模式工作区 P2e —— 交接「方案 B」）。
 *
 * 本地模式对话「在云端后台跑」的任务，以一张卡内联在对话时间线里（取代旧的工作区
 * 侧栏孤岛）：展示任务文本 + 状态（派发中 / 运行中 / 已完成 / 失败），随对话重开重放。
 *
 * 完成后就地展开内联简化评审（`BackgroundTaskReview`）把结果应用回本地——默认全部接受、
 * 只对真冲突逐个选择。`rootId` 为对话绑定的本地根（由 `useWorkspaceRootId` 上游解析），
 * 为空时（云端 / 未解析）只展示完成态、不提供评审入口。
 */
export function BackgroundTaskCard({
  job,
  rootId,
}: {
  job: HandoffJob;
  rootId: string | null;
}) {
  const meta = STATUS_META[job.status];

  return (
    <div
      className={`animate-task-card-enter rounded-xl border ${meta.border} ${meta.surface} p-3`}
    >
      <div className="flex items-start gap-2">
        <Cloud size={16} className={`mt-0.5 shrink-0 ${meta.accent}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-medium ${meta.accent}`}>
              后台云端任务
            </span>
            <StatusBadge job={job} />
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {formatWhen(job.createdAt)}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
            {job.task}
          </p>
          <Body job={job} rootId={rootId} />
        </div>
      </div>
    </div>
  );
}

function Body({ job, rootId }: { job: HandoffJob; rootId: string | null }) {
  const [reviewing, setReviewing] = useState(false);

  if (job.status === "pending") {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">
        正在打包本地文件并派发到云端…
      </p>
    );
  }
  if (job.status === "running") {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">
        云端团队正在后台处理，完成后会在这里通知你。
      </p>
    );
  }
  if (job.status === "failed") {
    return (
      <p className="mt-1.5 text-xs text-destructive">
        {job.error ? `失败：${job.error}` : "任务失败"}
      </p>
    );
  }

  // succeeded —— 内联评审需要本地根写回；rootId 为空（云端 / 未解析）只展示完成态。
  if (!rootId) {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">
        已完成 · 切到本地模式后可在此查看并应用结果。
      </p>
    );
  }
  if (reviewing) {
    return (
      <BackgroundTaskReview
        conversationId={job.sourceConversationId}
        jobId={job.id}
        rootId={rootId}
        onClose={() => setReviewing(false)}
      />
    );
  }
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setReviewing(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent"
      >
        <GitPullRequest size={13} />
        查看并应用
      </button>
    </div>
  );
}

function StatusBadge({ job }: { job: HandoffJob }) {
  const meta = STATUS_META[job.status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium ${meta.accent}`}
    >
      {meta.spin ? <Loader2 size={11} className="animate-spin" /> : meta.icon}
      {meta.label}
    </span>
  );
}

const STATUS_META: Record<
  HandoffJob["status"],
  {
    label: string;
    accent: string;
    border: string;
    surface: string;
    spin: boolean;
    icon: React.ReactNode;
  }
> = {
  pending: {
    label: "派发中",
    accent: "text-muted-foreground",
    border: "border-border",
    surface: "bg-card/60",
    spin: true,
    icon: null,
  },
  running: {
    label: "运行中",
    accent: "text-primary",
    border: "border-primary/40",
    surface: "bg-primary/10",
    spin: true,
    icon: null,
  },
  succeeded: {
    label: "已完成",
    accent: "text-success",
    border: "border-border",
    surface: "bg-card/60",
    spin: false,
    icon: <CheckCircle2 size={11} />,
  },
  failed: {
    label: "失败",
    accent: "text-destructive",
    border: "border-destructive/30",
    surface: "bg-destructive/10",
    spin: false,
    icon: <AlertTriangle size={11} />,
  },
};

/** 紧凑本地时间戳（如 "06-15 03:04"）。 */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
