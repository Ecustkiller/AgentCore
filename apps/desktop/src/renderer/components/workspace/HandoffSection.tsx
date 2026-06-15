import { SimpleTooltip } from "@/components/ui/tooltip";
import { StreamError } from "@/lib/errors";
import {
  type HandoffFileChange,
  type ReviewRow,
  type ThreeWayVerdict,
  buildReviewRows,
  buildSelections,
  countChanges,
  defaultDecision,
} from "@/lib/handoff-review";
import {
  type HandoffApplySummary,
  type HandoffJob,
  applyHandoffJob,
  dispatchHandoffJob,
  getHandoffDiff,
  listHandoffJobs,
  readLocalShas,
} from "@/services/handoff";
import {
  type WorkspaceBinding,
  getWorkspaceBinding,
} from "@/services/workspaceBinding";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  CloudUpload,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Send,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/** Poll cadence while a dispatched job is still pending/running (MVP=轮询, §九⑪). */
const POLL_MS = 4000;

/**
 * 交接面板（双模式工作区 P2e 前端）—— 本地→云交接的派发 / 轮询 / PR 评审一处汇总。
 *
 * 把活交给云端团队（e2 dispatch），轮询作业状态（e2 jobs），作业完成后开 PR 评审卡
 * 逐文件应用结果回本地（e3 diff/apply）。仅本地模式可派发/应用（云模式无本地文件可交）。
 */
export function HandoffSection({ conversationId }: { conversationId: string }) {
  const [binding, setBinding] = useState<WorkspaceBinding | null>(null);
  const [bindingError, setBindingError] = useState(false);
  const [jobs, setJobs] = useState<HandoffJob[] | null>(null);
  const [jobsError, setJobsError] = useState(false);
  const [task, setTask] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [reviewJob, setReviewJob] = useState<HandoffJob | null>(null);

  const loadBinding = useCallback(async () => {
    setBindingError(false);
    try {
      setBinding(await getWorkspaceBinding(conversationId));
    } catch {
      setBindingError(true);
    }
  }, [conversationId]);

  const loadJobs = useCallback(async () => {
    setJobsError(false);
    try {
      setJobs(await listHandoffJobs(conversationId));
    } catch {
      setJobsError(true);
    }
  }, [conversationId]);

  useEffect(() => {
    setBinding(null);
    setJobs(null);
    setReviewJob(null);
    void loadBinding();
    void loadJobs();
  }, [loadBinding, loadJobs]);

  // Poll while any job is still in flight so a finished cloud run flips to
  // 「查看结果」without the user hitting refresh (completion notice MVP=轮询).
  const inFlight = jobs?.some(
    (j) => j.status === "pending" || j.status === "running",
  );
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => void loadJobs(), POLL_MS);
    return () => clearInterval(id);
  }, [inFlight, loadJobs]);

  const isLocal = binding?.mode === "local";

  const onDispatch = useCallback(async () => {
    const text = task.trim();
    if (!text || dispatching) return;
    setDispatching(true);
    setDispatchError(null);
    try {
      await dispatchHandoffJob(conversationId, text);
      setTask("");
      await loadJobs();
    } catch (err) {
      setDispatchError(
        err instanceof StreamError
          ? "派发失败：网络或服务异常"
          : err instanceof Error
            ? err.message
            : "派发失败",
      );
    } finally {
      setDispatching(false);
    }
  }, [task, dispatching, conversationId, loadJobs]);

  if (reviewJob && binding?.rootId) {
    return (
      <HandoffReviewView
        conversationId={conversationId}
        job={reviewJob}
        rootId={binding.rootId}
        onBack={() => setReviewJob(null)}
        onApplied={() => void loadJobs()}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2.5">
        {binding === null && !bindingError ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            正在确认工作区模式…
          </div>
        ) : isLocal ? (
          <div className="flex flex-col gap-2">
            <label
              htmlFor="handoff-task"
              className="flex items-center gap-1.5 text-xs font-medium text-foreground"
            >
              <CloudUpload size={14} className="text-muted-foreground" />
              交给云端团队
            </label>
            <textarea
              id="handoff-task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void onDispatch();
                }
              }}
              rows={2}
              placeholder="描述要让云端团队完成的任务，会基于当前本地文件的快照开跑…"
              className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onDispatch()}
                disabled={dispatching || !task.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {dispatching ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Send size={13} />
                )}
                派发
              </button>
              <span className="text-xs text-muted-foreground">⌘/Ctrl+↵</span>
            </div>
            {dispatchError && (
              <p className="text-xs text-destructive">{dispatchError}</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            交接需要本地模式：把这个对话或所在文件夹绑定到本机目录后，才能把本地项目交给云端团队。
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <span className="flex-1 text-xs font-medium text-muted-foreground">
          交接作业
        </span>
        <SimpleTooltip label="刷新">
          <button
            type="button"
            onClick={() => void loadJobs()}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw size={14} />
          </button>
        </SimpleTooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {jobsError ? (
          <CenteredError onRetry={() => void loadJobs()} />
        ) : jobs === null ? (
          <Centered>
            <Loader2
              size={18}
              className="animate-spin text-muted-foreground/50"
            />
          </Centered>
        ) : jobs.length === 0 ? (
          <EmptyHint
            icon={
              <GitPullRequest size={22} className="text-muted-foreground/40" />
            }
            title="暂无交接作业"
            hint={
              isLocal
                ? "在上方写个任务派发给云端团队，完成后可在这里评审结果。"
                : "本地模式下把任务交给云端团队，作业会出现在这里。"
            }
          />
        ) : (
          <ul className="space-y-1.5">
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                canReview={!!binding?.rootId}
                onReview={() => setReviewJob(job)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function JobRow({
  job,
  canReview,
  onReview,
}: {
  job: HandoffJob;
  canReview: boolean;
  onReview: () => void;
}) {
  return (
    <li className="rounded-lg border border-border px-2.5 py-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-words text-sm">{job.task}</span>
        <JobStatusBadge status={job.status} />
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="flex-1 truncate text-xs text-muted-foreground">
          {formatWhen(job.createdAt)}
          {job.status === "failed" && job.error ? ` · ${job.error}` : ""}
        </span>
        {job.status === "succeeded" &&
          (canReview ? (
            <button
              type="button"
              onClick={onReview}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2 py-0.5 text-xs font-medium hover:bg-accent"
            >
              <GitPullRequest size={12} />
              查看结果
            </button>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">
              切到本地模式可应用
            </span>
          ))}
      </div>
    </li>
  );
}

function JobStatusBadge({ status }: { status: HandoffJob["status"] }) {
  const map = {
    pending: { label: "排队中", cls: "text-muted-foreground", spin: true },
    running: { label: "运行中", cls: "text-primary", spin: true },
    succeeded: { label: "已完成", cls: "text-success", spin: false },
    failed: { label: "失败", cls: "text-destructive", spin: false },
  } as const;
  const s = map[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium ${s.cls}`}
    >
      {s.spin && <Loader2 size={11} className="animate-spin" />}
      {s.label}
    </span>
  );
}

/**
 * PR 评审卡（双模式工作区 P2e / e3）—— 取来 diff，逐文件读本地哈希三方判定，让用户按
 * 文件选「取云端 / 保留本地」（冲突标红，选云端即覆盖），一键应用回本地并显示逐文件结果。
 */
function HandoffReviewView({
  conversationId,
  job,
  rootId,
  onBack,
  onApplied,
}: {
  conversationId: string;
  job: HandoffJob;
  rootId: string;
  onBack: () => void;
  onApplied: () => void;
}) {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [error, setError] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [summary, setSummary] = useState<HandoffApplySummary | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setError(false);
    setRows(null);
    setSummary(null);
    try {
      const diff = await getHandoffDiff(conversationId, job.id);
      const shas = await readLocalShas(
        rootId,
        diff.changes.map((c) => c.path),
      );
      if (mounted.current) setRows(buildReviewRows(diff.changes, shas));
    } catch {
      if (mounted.current) setError(true);
    }
  }, [conversationId, job.id, rootId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setDecision = useCallback(
    (path: string, decision: ReviewRow["decision"]) => {
      setRows((prev) =>
        prev
          ? prev.map((r) => (r.change.path === path ? { ...r, decision } : r))
          : prev,
      );
    },
    [],
  );

  const setAll = useCallback((decision: ReviewRow["decision"]) => {
    setRows((prev) => (prev ? prev.map((r) => ({ ...r, decision })) : prev));
  }, []);

  const resetDefaults = useCallback(() => {
    setRows((prev) =>
      prev
        ? prev.map((r) => ({ ...r, decision: defaultDecision(r.verdict) }))
        : prev,
    );
  }, []);

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onApply = useCallback(async () => {
    if (!rows || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      // Re-hash local files right before writing so the server's conflict gate
      // sees the *current* disk state, not what we read when the review opened.
      // A file edited since review is then caught (a "clean→云端" pick refuses as
      // conflict) rather than silently clobbered. `force` stays bound to the user's
      // informed review decision (buildSelections keys it off the review-time
      // verdict), so a file that turned conflicting after review is refused — never
      // auto-forced.
      const freshShas = await readLocalShas(
        rootId,
        rows.map((r) => r.change.path),
      );
      const selections = buildSelections(
        rows.map((r) => ({
          ...r,
          localSha: freshShas.get(r.change.path) ?? null,
        })),
      );
      const result = await applyHandoffJob(conversationId, job.id, selections);
      if (mounted.current) {
        setSummary(result);
        onApplied();
      }
    } catch (err) {
      if (mounted.current) {
        setApplyError(
          err instanceof StreamError
            ? "应用失败：网络或服务异常"
            : err instanceof Error
              ? err.message
              : "应用失败",
        );
      }
    } finally {
      if (mounted.current) setApplying(false);
    }
  }, [rows, applying, conversationId, job.id, rootId, onApplied]);

  const counts = rows ? countChanges(rows.map((r) => r.change)) : null;
  const forcedConflicts = rows
    ? rows.filter((r) => r.verdict === "conflict" && r.decision === "cloud")
        .length
    : 0;
  const resultByPath = new Map(summary?.results.map((r) => [r.path, r]) ?? []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border pl-1 pr-2">
        <SimpleTooltip label="返回作业列表">
          <button
            type="button"
            onClick={onBack}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft size={16} />
          </button>
        </SimpleTooltip>
        <GitPullRequest size={13} className="shrink-0 text-muted-foreground" />
        <SimpleTooltip label={job.task}>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {job.task}
          </span>
        </SimpleTooltip>
      </div>

      {counts && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-xs">
          <span className="text-success">+{counts.added} 新增</span>
          <span className="text-info">~{counts.modified} 修改</span>
          <span className="text-destructive">-{counts.deleted} 删除</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {error ? (
          <CenteredError onRetry={() => void load()} />
        ) : rows === null ? (
          <Centered>
            <Loader2
              size={18}
              className="animate-spin text-muted-foreground/50"
            />
          </Centered>
        ) : rows.length === 0 ? (
          <EmptyHint
            icon={
              <CheckCircle2 size={22} className="text-muted-foreground/40" />
            }
            title="没有需要应用的变更"
            hint="云端团队的结果与基线一致，本地无需改动。"
          />
        ) : (
          <>
            {!summary && (
              <div className="mb-2 flex items-center gap-2 px-1">
                <button
                  type="button"
                  onClick={() => setAll("cloud")}
                  className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-accent"
                >
                  全选云端
                </button>
                <button
                  type="button"
                  onClick={() => setAll("local")}
                  className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-accent"
                >
                  全选本地
                </button>
                <button
                  type="button"
                  onClick={resetDefaults}
                  className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-accent"
                >
                  恢复推荐
                </button>
              </div>
            )}
            <ul className="space-y-1">
              {rows.map((row) => (
                <ReviewRowItem
                  key={row.change.path}
                  row={row}
                  expanded={expanded.has(row.change.path)}
                  onToggleExpand={() => toggleExpand(row.change.path)}
                  onDecision={(d) => setDecision(row.change.path, d)}
                  result={resultByPath.get(row.change.path) ?? null}
                  locked={summary !== null}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      {rows && rows.length > 0 && (
        <div className="shrink-0 border-t border-border px-3 py-2">
          {summary ? (
            <ApplySummaryBar summary={summary} onBack={onBack} />
          ) : (
            <>
              {forcedConflicts > 0 && (
                <p className="mb-1.5 flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle size={12} />
                  将强制覆盖 {forcedConflicts} 个有本地改动的文件
                </p>
              )}
              {applyError && (
                <p className="mb-1.5 text-xs text-destructive">{applyError}</p>
              )}
              <button
                type="button"
                onClick={() => void onApply()}
                disabled={applying}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {applying ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <CloudUpload size={14} />
                )}
                应用到本地
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewRowItem({
  row,
  expanded,
  onToggleExpand,
  onDecision,
  result,
  locked,
}: {
  row: ReviewRow;
  expanded: boolean;
  onToggleExpand: () => void;
  onDecision: (d: ReviewRow["decision"]) => void;
  result: { status: string; detail: string } | null;
  locked: boolean;
}) {
  const { change } = row;
  const canPreview =
    !change.isBinary &&
    change.changeType !== "deleted" &&
    change.content !== null;

  return (
    <li className="rounded-lg border border-border">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <SimpleTooltip label={canPreview ? "展开预览云端版本" : "无可预览内容"}>
          <span className="flex shrink-0">
            <button
              type="button"
              onClick={onToggleExpand}
              disabled={!canPreview}
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
            >
              {expanded ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
            </button>
          </span>
        </SimpleTooltip>
        <ChangeTypeMark type={change.changeType} />
        <SimpleTooltip label={change.path}>
          <span className="min-w-0 flex-1 truncate text-xs">{change.path}</span>
        </SimpleTooltip>
        {result ? (
          <ApplyResultBadge status={result.status} detail={result.detail} />
        ) : (
          <VerdictBadge verdict={row.verdict} />
        )}
      </div>

      {!locked && (
        <div className="flex items-center gap-1 border-t border-border/60 px-2 py-1">
          <DecisionToggle
            active={row.decision === "cloud"}
            onClick={() => onDecision("cloud")}
            label={row.verdict === "conflict" ? "云端（覆盖）" : "云端"}
            danger={row.verdict === "conflict"}
          />
          <DecisionToggle
            active={row.decision === "local"}
            onClick={() => onDecision("local")}
            label="本地"
          />
          {row.verdict === "conflict" && (
            <span className="ml-1 flex items-center gap-0.5 text-xs text-warning">
              <AlertTriangle size={11} />
              本地有改动
            </span>
          )}
        </div>
      )}

      {expanded && canPreview && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground">
          {change.content}
        </pre>
      )}
    </li>
  );
}

function DecisionToggle({
  active,
  onClick,
  label,
  danger,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  const base =
    "rounded-lg px-2 py-0.5 text-xs font-medium transition-colors border";
  const cls = active
    ? danger
      ? "border-warning bg-warning/10 text-warning"
      : "border-primary bg-primary/10 text-primary"
    : "border-transparent text-muted-foreground hover:bg-accent";
  return (
    <button type="button" onClick={onClick} className={`${base} ${cls}`}>
      {label}
    </button>
  );
}

function ChangeTypeMark({ type }: { type: HandoffFileChange["changeType"] }) {
  const map = {
    added: { ch: "+", cls: "text-success" },
    modified: { ch: "~", cls: "text-info" },
    deleted: { ch: "-", cls: "text-destructive" },
  } as const;
  const m = map[type];
  return (
    <span className={`shrink-0 font-mono text-xs font-bold ${m.cls}`}>
      {m.ch}
    </span>
  );
}

function VerdictBadge({ verdict }: { verdict: ThreeWayVerdict }) {
  const map = {
    clean: { label: "可应用", cls: "text-muted-foreground" },
    applied: { label: "已应用", cls: "text-success" },
    conflict: { label: "冲突", cls: "text-warning" },
  } as const;
  const v = map[verdict];
  return (
    <span className={`shrink-0 text-xs font-medium ${v.cls}`}>{v.label}</span>
  );
}

function ApplyResultBadge({
  status,
  detail,
}: {
  status: string;
  detail: string;
}) {
  const map: Record<
    string,
    { label: string; cls: string; icon: React.ReactNode }
  > = {
    applied: {
      label: "已应用",
      cls: "text-success",
      icon: <CheckCircle2 size={12} />,
    },
    skipped: {
      label: "已跳过",
      cls: "text-muted-foreground",
      icon: <CircleSlash size={12} />,
    },
    conflict: {
      label: "冲突",
      cls: "text-warning",
      icon: <AlertTriangle size={12} />,
    },
    error: {
      label: "失败",
      cls: "text-destructive",
      icon: <XCircle size={12} />,
    },
  };
  const s = map[status] ?? map.error;
  const badge = (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium ${s.cls}`}
    >
      {s.icon}
      {s.label}
    </span>
  );
  return detail ? <SimpleTooltip label={detail}>{badge}</SimpleTooltip> : badge;
}

function ApplySummaryBar({
  summary,
  onBack,
}: {
  summary: HandoffApplySummary;
  onBack: () => void;
}) {
  const parts: string[] = [];
  if (summary.applied) parts.push(`${summary.applied} 已应用`);
  if (summary.skipped) parts.push(`${summary.skipped} 跳过`);
  if (summary.conflicts) parts.push(`${summary.conflicts} 冲突`);
  if (summary.errors) parts.push(`${summary.errors} 失败`);
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 text-xs text-muted-foreground">
        {parts.length ? parts.join(" · ") : "无变更"}
      </span>
      <button
        type="button"
        onClick={onBack}
        className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent"
      >
        返回
      </button>
    </div>
  );
}

// --- shared bits (local to the handoff section) ---

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">{children}</div>
  );
}

function CenteredError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-xs text-muted-foreground">加载失败</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-accent"
      >
        重试
      </button>
    </div>
  );
}

function EmptyHint({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      {icon}
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** Compact local timestamp (e.g. "06-15 03:04"). */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
