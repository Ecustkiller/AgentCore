import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { TeamPreviewWorkerView } from "./types";
import {
  formatWorkspaceLabel,
  resolveWorkspacePresentation,
} from "./workspacePresentation";

type ReadonlyProps = {
  mode?: "readonly";
  workers: readonly TeamPreviewWorkerView[];
};

type InteractiveProps = {
  mode: "interactive";
  workers: readonly TeamPreviewWorkerView[];
  textOnlyRunIds: ReadonlySet<string>;
  onTextOnlyChange: (runId: string, textOnly: boolean) => void;
  disabled?: boolean;
};

export type WorkerPreviewRowsProps = ReadonlyProps | InteractiveProps;

/**
 * Worker 分工表 — shared by hot TeamPreviewCard/Graph (readonly) and cold
 * TeamPreviewResumeCard (interactive: 写盘收紧 / 任务折叠).
 * CEO 提案模型只读展示；人改模型 / 排除岗 UI 已撤（后端契约仍保留）。
 * 工作区：全员同桌一行汇总，不一致逐人；旧帧无显示名不画。
 */
export function WorkerPreviewRows(props: WorkerPreviewRowsProps) {
  if (props.mode === "interactive") {
    return <InteractiveWorkerRows {...props} />;
  }
  return <ReadonlyWorkerRows workers={props.workers} />;
}

function WorkspaceSummary({ name }: { name: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {formatWorkspaceLabel(name)}
    </p>
  );
}

function WorkspaceChip({ name }: { name: string }) {
  return (
    <span className="text-xs text-muted-foreground">
      {formatWorkspaceLabel(name)}
    </span>
  );
}

function ReadonlyWorkerRows({
  workers,
}: {
  workers: readonly TeamPreviewWorkerView[];
}) {
  const desk = resolveWorkspacePresentation(workers);
  return (
    <div className="mt-2 space-y-1.5">
      {desk.mode === "summary" && <WorkspaceSummary name={desk.name} />}
      {workers.map((w) => (
        <div
          key={w.run_id}
          className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-xs font-medium text-foreground">{w.role}</p>
            {w.model && (
              <span className="text-xs text-muted-foreground">{w.model}</span>
            )}
            {w.write_capability_label && (
              <span
                className={
                  w.write_capability === "text_only"
                    ? "text-xs font-medium text-muted-foreground"
                    : "text-xs text-muted-foreground"
                }
              >
                {w.write_capability_label}
              </span>
            )}
            {desk.mode === "perWorker" && w.target_folder_name && (
              <WorkspaceChip name={w.target_folder_name} />
            )}
            {w.depends_on.length > 0 && (
              <span className="text-xs text-muted-foreground">
                依赖 {w.depends_on.length} 步
              </span>
            )}
          </div>
          {w.task && (
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
              {w.task}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function InteractiveWorkerRows({
  workers,
  textOnlyRunIds,
  onTextOnlyChange,
  disabled,
}: InteractiveProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const desk = resolveWorkspacePresentation(workers);

  const toggle = (runId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  return (
    <div className="mt-2 space-y-1.5">
      {desk.mode === "summary" && <WorkspaceSummary name={desk.name} />}
      {workers.map((w) => {
        const open = expanded.has(w.run_id);
        const effectiveTextOnly =
          textOnlyRunIds.has(w.run_id) || w.write_capability === "text_only";
        const canTighten =
          w.write_capability === "can_write_files" &&
          !textOnlyRunIds.has(w.run_id);
        const writeLabel = effectiveTextOnly
          ? (w.write_capability === "text_only"
              ? w.write_capability_label
              : undefined) || "仅文字报告"
          : w.write_capability_label || "可改文件";

        const meta = (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <p className="min-w-0 text-xs font-medium text-foreground">
              {w.role}
            </p>
            {w.model && (
              <span className="text-xs text-muted-foreground">{w.model}</span>
            )}
            {(w.write_capability || textOnlyRunIds.has(w.run_id)) &&
              (canTighten ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTextOnlyChange(w.run_id, true);
                  }}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-40"
                  aria-label={`${w.role} 收紧为仅文字`}
                >
                  {writeLabel}
                  <span className="text-muted-foreground/80"> → 仅文字</span>
                </button>
              ) : (
                <span
                  className={
                    effectiveTextOnly
                      ? "text-xs font-medium text-muted-foreground"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {writeLabel}
                </span>
              ))}
            {textOnlyRunIds.has(w.run_id) &&
              w.write_capability === "can_write_files" && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTextOnlyChange(w.run_id, false);
                  }}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-40"
                  aria-label={`${w.role} 撤销写盘收紧`}
                >
                  撤销
                </button>
              )}
            {desk.mode === "perWorker" && w.target_folder_name && (
              <WorkspaceChip name={w.target_folder_name} />
            )}
            {w.depends_on.length > 0 && (
              <span className="text-xs text-muted-foreground">
                依赖 {w.depends_on.length} 步
              </span>
            )}
          </div>
        );

        if (!w.task) {
          return (
            <div
              key={w.run_id}
              className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
            >
              <div className="flex items-start gap-1.5">{meta}</div>
            </div>
          );
        }

        return (
          <div
            key={w.run_id}
            className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
          >
            <div className="flex items-start gap-1.5">{meta}</div>
            <button
              type="button"
              onClick={() => toggle(w.run_id)}
              aria-expanded={open}
              aria-label={open ? `收起 ${w.role} 任务` : `展开 ${w.role} 任务`}
              className="mt-0.5 w-full text-left"
            >
              <div className="flex items-start gap-1.5">
                <p
                  className={
                    open
                      ? "min-w-0 flex-1 whitespace-pre-wrap text-xs text-muted-foreground"
                      : "min-w-0 flex-1 line-clamp-1 text-xs text-muted-foreground"
                  }
                >
                  {w.task}
                </p>
                {open ? (
                  <ChevronDown
                    size={14}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                ) : (
                  <ChevronRight
                    size={14}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                )}
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
}
