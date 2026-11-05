import { NarrowMenuButton } from "@/components/layout/NarrowMenuButton";
import {
  Badge,
  Button,
  Card,
  IconButton,
  PageHeader,
  SearchField,
  SegmentedControl,
} from "@/components/ui";
import {
  useConversations,
  useGroupedConversationsSettled,
} from "@/hooks/useConversations";
import {
  isHandoffTaskAwaitingUser,
  isHandoffTaskRunning,
  useHandoffTasks,
} from "@/hooks/useHandoffTasks";
import { useNarrowLayoutState } from "@/lib/narrowLayout";
import { cn } from "@/lib/utils";
import type { HandoffJob, HandoffJobStatus } from "@/services/handoff";
import { useConversationStore } from "@/stores/conversation";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CircleX,
  ListChecks,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

type TaskFilter = "all" | "running" | "attention" | "finished";

const FILTERS: Array<{ value: TaskFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "running", label: "进行中" },
  { value: "attention", label: "待处理" },
  { value: "finished", label: "已结束" },
];

function matchesFilter(job: HandoffJob, filter: TaskFilter): boolean {
  if (filter === "all") return true;
  if (filter === "running") return isHandoffTaskRunning(job);
  if (filter === "attention") return isHandoffTaskAwaitingUser(job);
  return (
    job.status === "applied" ||
    job.status === "discarded" ||
    job.status === "failed"
  );
}

export function TaskCenterPage() {
  const tasks = useHandoffTasks();
  const conversations = useConversations();
  const conversationsSettled = useGroupedConversationsSettled();
  const { isNarrow } = useNarrowLayoutState();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");

  const titleById = useMemo(
    () =>
      new Map(
        conversations.map((conversation) => [
          conversation.id,
          conversation.title,
        ]),
      ),
    [conversations],
  );
  const jobs = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (tasks.data ?? []).filter((job) => {
      if (!matchesFilter(job, filter)) return false;
      if (!needle) return true;
      const title = titleById.get(job.sourceConversationId) ?? "";
      return `${job.task}\n${title}`.toLocaleLowerCase().includes(needle);
    });
  }, [filter, query, tasks.data, titleById]);

  const counts = useMemo(() => {
    const list = tasks.data ?? [];
    return {
      all: list.length,
      running: list.filter(isHandoffTaskRunning).length,
      attention: list.filter(isHandoffTaskAwaitingUser).length,
      finished: list.filter((job) => matchesFilter(job, "finished")).length,
    };
  }, [tasks.data]);

  const openConversation = (conversationId: string) => {
    useConversationStore.getState().switchConversation(conversationId);
    navigate(`/conversations/${conversationId}`);
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {isNarrow && (
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-card px-2 pt-[env(safe-area-inset-top)]">
          <NarrowMenuButton />
          <h1 className="min-w-0 flex-1 truncate text-center text-sm font-medium">
            任务
          </h1>
          <IconButton
            size="md"
            aria-label="刷新任务"
            disabled={tasks.isFetching}
            onClick={() => void tasks.refetch()}
          >
            <RefreshCw
              size={17}
              className={cn(tasks.isFetching && "animate-spin")}
            />
          </IconButton>
        </header>
      )}

      <div
        className={cn(
          "mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col",
          isNarrow ? "px-4 py-4" : "px-4 py-5 sm:px-6",
        )}
      >
        {!isNarrow && (
          <PageHeader
            title="任务"
            meta={
              counts.running > 0
                ? `${counts.running} 个进行中`
                : counts.attention > 0
                  ? `${counts.attention} 个待处理`
                  : `${counts.all} 个任务`
            }
            action={
              <Button
                variant="neutral"
                className="border border-border"
                icon={
                  <RefreshCw
                    size={13}
                    className={cn(tasks.isFetching && "animate-spin")}
                  />
                }
                disabled={tasks.isFetching}
                onClick={() => void tasks.refetch()}
              >
                刷新
              </Button>
            }
          />
        )}

        <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_15rem]">
          <SegmentedControl
            aria-label="任务状态"
            value={filter}
            onChange={setFilter}
            items={FILTERS.map((item) => ({
              value: item.value,
              label: `${item.label} ${counts[item.value]}`,
            }))}
          />
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="搜索任务或对话"
            aria-label="搜索任务"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          {tasks.isLoading ? (
            <TaskCenterState
              icon={<Loader2 size={18} className="animate-spin" />}
              title="正在读取任务"
            />
          ) : tasks.isError ? (
            <TaskCenterState
              icon={<AlertTriangle size={18} className="text-destructive" />}
              title="任务加载失败"
              action={
                <Button variant="outline" onClick={() => void tasks.refetch()}>
                  重试
                </Button>
              }
            />
          ) : jobs.length === 0 ? (
            <TaskCenterState
              icon={<ListChecks size={18} />}
              title={
                tasks.data?.length
                  ? "没有匹配的任务"
                  : filter === "all"
                    ? "还没有后台任务"
                    : "这个分组暂无任务"
              }
            />
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <TaskRow
                  key={job.id}
                  job={job}
                  sourceTitle={titleById.get(job.sourceConversationId)}
                  sourceSettled={conversationsSettled}
                  onOpen={openConversation}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskRow({
  job,
  sourceTitle,
  sourceSettled,
  onOpen,
}: {
  job: HandoffJob;
  sourceTitle: string | undefined;
  sourceSettled: boolean;
  onOpen: (conversationId: string) => void;
}) {
  const meta = statusMeta(job.status);
  const target =
    job.status === "succeeded"
      ? job.sourceConversationId
      : job.status === "applied" || job.status === "discarded"
        ? job.sourceConversationId
        : job.jobConversationId;

  return (
    <Card className="p-3" variant="interactive">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg",
            meta.iconSurface,
          )}
        >
          {meta.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 flex-1 line-clamp-2 break-words text-sm font-medium text-foreground">
              {job.task.trim() || "未命名任务"}
            </p>
            <Badge tone={meta.tone} className="gap-1">
              {meta.spin ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                meta.icon
              )}
              {meta.label}
            </Badge>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="max-w-full truncate">
              {sourceTitle
                ? `来源：${sourceTitle}`
                : sourceSettled
                  ? "来源对话不可用"
                  : "正在读取来源"}
            </span>
            <span aria-hidden="true">·</span>
            <span>{formatTaskTime(job)}</span>
            {job.status === "failed" && job.error ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="max-w-full truncate text-destructive">
                  {job.error}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <Button
          variant="neutral"
          className="shrink-0 border border-border"
          icon={<ArrowUpRight size={13} />}
          onClick={() => onOpen(target)}
        >
          {job.status === "succeeded" ? "处理结果" : "打开"}
        </Button>
      </div>
    </Card>
  );
}

function TaskCenterState({
  icon,
  title,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-4 text-center">
      <span className="text-muted-foreground">{icon}</span>
      <p className="text-sm text-muted-foreground">{title}</p>
      {action}
    </div>
  );
}

function statusMeta(status: HandoffJobStatus): {
  label: string;
  tone: "primary" | "success" | "destructive" | "muted";
  spin: boolean;
  icon: React.ReactNode;
  iconSurface: string;
} {
  switch (status) {
    case "pending":
      return {
        label: "派发中",
        tone: "muted",
        spin: true,
        icon: null,
        iconSurface: "bg-muted text-muted-foreground",
      };
    case "running":
      return {
        label: "运行中",
        tone: "primary",
        spin: true,
        icon: null,
        iconSurface: "bg-primary/10 text-primary",
      };
    case "succeeded":
      return {
        label: "待处理",
        tone: "primary",
        spin: false,
        icon: <CheckCircle2 size={12} />,
        iconSurface: "bg-primary/10 text-primary",
      };
    case "failed":
      return {
        label: "失败",
        tone: "destructive",
        spin: false,
        icon: <AlertTriangle size={12} />,
        iconSurface: "bg-destructive/10 text-destructive",
      };
    case "applied":
      return {
        label: "已合回",
        tone: "success",
        spin: false,
        icon: <CheckCircle2 size={12} />,
        iconSurface: "bg-success/10 text-success",
      };
    case "discarded":
      return {
        label: "已放弃",
        tone: "muted",
        spin: false,
        icon: <CircleX size={12} />,
        iconSurface: "bg-muted text-muted-foreground",
      };
  }
}

function formatTaskTime(job: HandoffJob): string {
  const iso = job.finishedAt ?? job.createdAt;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
