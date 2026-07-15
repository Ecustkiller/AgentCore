import {
  type ToolResultData,
  ToolResultView,
  hasToolResultBody,
  toolResultPeek,
} from "@/components/chat/toolResult/ToolResultView";
import { Badge, Button } from "@/components/ui";
import { formatCompact } from "@/lib/format";
import {
  usePersistentDisclosure,
  useStreamAwareDisclosure,
} from "@/stores/disclosure";
import type { ProcessStep } from "@/types/events";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ThinkingDots } from "./message-bubble/Thinking";
import {
  toolDetail,
  toolGroupSummary,
  toolMeta,
  toolPhaseText,
} from "./message-bubble/constants";

/** Tools whose rich result card auto-opens once when they finish (结果卡自动展开): the output
 * IS the payload the user was waiting on — web_search's hits, code_execute's terminal output
 * (incl. a failing run's stderr), file_write/str_replace's diff — so hiding it behind a click
 * is pure friction. Every other tool keeps the collapsed default; a later manual collapse on
 * these still sticks. */
const AUTO_EXPAND_ON_DONE = new Set([
  "web_search",
  "code_execute",
  "file_write",
  "str_replace",
]);

/** Live transport line while the model streams tool-call JSON (不持久化). */
export function ComposingToolLine({
  tool,
}: {
  tool: { toolName: string; chars: number };
}) {
  const { Icon, label } = toolMeta(tool.toolName);
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Icon size={14} className="shrink-0 text-primary" />
      <span>
        正在生成 {label}
        {tool.chars > 0 && (
          <span className="text-muted-foreground/70">
            {" · "}
            {formatCompact(tool.chars)} 字
          </span>
        )}
      </span>
      <span className="inline-block animate-pulse text-primary">▋</span>
    </span>
  );
}

/** Seconds a tool has been running, ticking client-side from when this row first saw
 * `running` (≈ the tool_use_start instant). A live liveliness cue for a BLOCKING tool
 * (web_search) whose execution streams no incremental progress. Resets when not running. */
function useRunningElapsed(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [running]);
  return elapsed;
}

/** Shimmer placeholder rows shown while web_search is running — turns the bare waiting
 * spinner into a「结果正在来」affordance. The search is atomic (nothing to stream), so
 * this only previews the result cards' shape until the real hits land. */
function WebSearchSkeleton() {
  return (
    <div className="mt-1 space-y-1.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-2 px-2 py-1">
          <div className="mt-0.5 size-4 shrink-0 animate-pulse rounded bg-muted" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ToolStatusIcon({
  status,
}: {
  status: "running" | "success" | "error";
}) {
  if (status === "running")
    return (
      <span className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
    );
  // The verdict icon mounts fresh on the running→done edge, so a one-shot pop
  // marks the state change (设计 §3); reduced-motion skips it.
  if (status === "error")
    return (
      <X
        size={14}
        className="mt-0.5 shrink-0 animate-status-pop text-destructive motion-reduce:animate-none"
      />
    );
  return (
    <Check
      size={14}
      className="mt-0.5 shrink-0 animate-status-pop text-success motion-reduce:animate-none"
    />
  );
}

/** Single tool invocation row in the process timeline. */
export function ToolLine({
  step,
  turnKey,
}: {
  step: Extract<ProcessStep, { kind: "tool" }>;
  /** 回合作用域标识（= messageId）：给了才把「结果卡开合」持久化（切对话/刷新后仍在），
   *  按 `${turnKey}:tool:${step.id}` 落 localStorage；缺省（如渲染测试）退化为会话内存态。 */
  turnKey?: string;
}) {
  const [open, setOpen] = usePersistentDisclosure(
    turnKey ? `${turnKey}:tool:${step.id}` : null,
    false,
  );
  const { Icon, label } = toolMeta(step.tool_name);
  const detail = toolDetail(step.arguments);
  const data: ToolResultData = {
    toolName: step.tool_name,
    args: step.arguments,
    result: step.result,
    display: step.display,
    status: step.status,
  };
  const hasBody = hasToolResultBody(data);
  const running = step.status === "running";
  const isWebSearch = step.tool_name === "web_search";
  const autoExpandsOnDone = AUTO_EXPAND_ON_DONE.has(step.tool_name);
  const elapsed = useRunningElapsed(running);

  // 结果卡自动展开: open the rich result once when an auto-expand tool finishes, so the
  // user sees the payload without a click — web_search hits, code_execute terminal,
  // file_write/str_replace diff. One-shot on the running→done edge — a later manual
  // collapse sticks; other tools keep the collapsed default.
  const prevRunning = useRef(running);
  useEffect(() => {
    if (prevRunning.current && !running && autoExpandsOnDone && hasBody)
      setOpen(true);
    prevRunning.current = running;
  }, [running, autoExpandsOnDone, hasBody, setOpen]);

  // Waiting-state hint (联网搜索前端展示优化): coarse phase (正在检索 / 排队中 / 改用备用引擎)
  // plus a live elapsed timer, replacing the dead spinner. Empty at the very first instant
  // (no phase yet, <1s) — the pulsing dot + skeleton still convey life.
  const runningHint = running
    ? [toolPhaseText(step.phase), elapsed >= 1 ? `${elapsed}s` : null]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <div className="min-w-0">
      <Button
        variant="ghost"
        onClick={() => hasBody && setOpen((v) => !v)}
        className={`h-auto w-full justify-start gap-2 px-0 py-0 hover:bg-transparent ${
          hasBody ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="flex w-full items-start gap-2 text-left">
          <Icon size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="text-sm text-foreground">
              <span className="font-medium">{label}</span>
              {detail && (
                <span className="ml-1.5 break-all text-muted-foreground">
                  {detail}
                </span>
              )}
            </span>
            {runningHint && (
              <span className="block truncate text-xs text-muted-foreground/70">
                {runningHint}
              </span>
            )}
            {hasBody && !open && (
              <span
                className={`block truncate text-xs ${
                  step.status === "error"
                    ? "text-destructive/80"
                    : "text-muted-foreground/70"
                }`}
              >
                {toolResultPeek(data)}
              </span>
            )}
          </span>
          <ToolStatusIcon status={step.status} />
        </span>
      </Button>
      {running && isWebSearch && <WebSearchSkeleton />}
      {open && hasBody && <ToolResultView data={data} />}
    </div>
  );
}

/** Collapsible group of consecutive tool lines (ProcessToolGroup pattern). */
export function ToolLineGroup({
  tools,
  isStreaming,
  turnKey,
  groupKey,
}: {
  tools: Extract<ProcessStep, { kind: "tool" }>[];
  isStreaming: boolean;
  /** 回合作用域标识（= messageId）：给了才把「工具组开合」持久化；缺省退化为会话内存态。 */
  turnKey?: string;
  /** 该工具组的稳定标识（timelineNodeKeys，首个 tool 的 id）——组成持久化键；
   *  标记中段插入（insertBeforeTeam）不再位移它。 */
  groupKey?: string;
}) {
  // 「直播中自动展开盯着看、收场后按保存值」（Q3）：取代旧的「流式默认展开 + 收场强制收起」，
  // 收场后不再强收，而是回到用户持久化的选择。
  const [expanded, toggleExpanded] = useStreamAwareDisclosure(
    turnKey != null && groupKey != null ? `${turnKey}:tgrp:${groupKey}` : null,
    isStreaming,
  );

  const summary = toolGroupSummary(tools);
  const errorCount = tools.reduce(
    (n, t) => n + (t.status === "error" ? 1 : 0),
    0,
  );
  const running = tools.some((t) => t.status === "running");

  return (
    <div>
      <Button
        variant="ghost"
        onClick={toggleExpanded}
        className="h-auto w-full justify-start gap-2 px-0 py-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        <span className="flex w-full items-center gap-2">
          {running ? (
            <ThinkingDots />
          ) : expanded ? (
            <ChevronDown size={14} className="shrink-0" />
          ) : (
            <ChevronRight size={14} className="shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
          {errorCount > 0 && (
            <Badge tone="destructive" className="shrink-0 font-normal">
              {errorCount} 个失败
            </Badge>
          )}
        </span>
      </Button>
      {expanded && (
        <div className="mt-1.5 space-y-2 pl-3">
          {tools.map((t) => (
            <ToolLine key={t.id} step={t} turnKey={turnKey} />
          ))}
        </div>
      )}
    </div>
  );
}
