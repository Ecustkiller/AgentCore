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
import { useEffect, useState } from "react";
import {
  isReadUrlSourceGroup,
  ReadUrlSourceCollection,
} from "./ReadUrlSourceCollection";
import { ThinkingDots } from "./message-bubble/Thinking";
import {
  toolDetail,
  toolGroupSummary,
  toolMeta,
  toolPhaseText,
} from "./message-bubble/constants";

/** Consult tools (查阅能力 / 查阅记忆) whose collapsed title already names exactly what was
 * pulled —「查阅能力 <name>」/「查阅记忆 <topic>」— and whose full body is one click away. Their
 * peek would only repeat the summary shown again inside the expanded card (skill) or the topic
 * already in the title (memory), so skip the peek line entirely — collapsed rows stay a clean
 * single line (mirrors how web_search folds its count into the title instead of a peek). */
const PEEK_SUPPRESSED = new Set(["consult_skill", "consult_memory"]);

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
        Composing {label}
        {tool.chars > 0 && (
          <span className="text-muted-foreground/70">
            {" · "}
            {formatCompact(tool.chars)} chars
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

/** 行尾指示（顶层工具行对齐「读取网页 · N 个来源」）：进行中脉冲点；否则失败打红✗，
 *  顶层可展开行补一个折叠 chevron（open→ChevronUp / 收起→ChevronDown）明确可开合；
 *  组内明细子行仍用成功绿✓。顶层成功即只留 chevron，成功由「无红✗」隐含（与 read_url 组一致）。 */
function ToolRowTail({
  status,
  nested,
  hasBody,
  open,
}: {
  status: "running" | "success" | "error";
  nested: boolean;
  hasBody: boolean;
  open: boolean;
}) {
  if (status === "running")
    return (
      <span className="ml-1.5 inline-block size-1.5 animate-pulse rounded-full bg-primary align-middle" />
    );
  // The verdict icon mounts fresh on the running→done edge, so a one-shot pop marks the
  // state change (设计 §3); reduced-motion skips it. 行尾指示紧跟标题文字（自适应内容右侧、
  // 不撑到行边缘）：失败红✗；顶层可展开补折叠 chevron；组内明细子行用成功绿✓。
  return (
    <span className="ml-1 inline-flex items-center gap-1 align-middle">
      {status === "error" && (
        <X
          size={14}
          className="animate-status-pop text-destructive motion-reduce:animate-none"
        />
      )}
      {nested && status === "success" && (
        <Check
          size={14}
          className="animate-status-pop text-success motion-reduce:animate-none"
        />
      )}
      {!nested &&
        hasBody &&
        (open ? (
          <ChevronDown size={14} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground" />
        ))}
    </span>
  );
}

/** Single tool invocation row in the process timeline. */
export function ToolLine({
  step,
  turnKey,
  nested = false,
}: {
  step: Extract<ProcessStep, { kind: "tool" }>;
  /** 回合作用域标识（= messageId）：给了才把「结果卡开合」持久化（切对话/刷新后仍在），
   *  按 `${turnKey}:tool:${step.id}` 落 localStorage；缺省（如渲染测试）退化为会话内存态。 */
  turnKey?: string;
  /** 是否为「工具组展开后的缩进明细子行」。顶层孤立工具行（默认 false）走 header 规格
   *  （text-xs·灰·不加粗·成功无✓），与思考过程/工具组同级不再突兀；组内子行（true）保留
   *  明细规格（text-sm·深色·加粗·成功绿✓），靠 pl-3 缩进与父摘要行区分层级。 */
  nested?: boolean;
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
  const suppressesPeek = PEEK_SUPPRESSED.has(step.tool_name);
  const elapsed = useRunningElapsed(running);

  // Waiting-state hint (联网搜索前端展示优化): coarse phase (正在检索 / 排队中 / 改用备用引擎)
  // plus a live elapsed timer, replacing the dead spinner. Empty at the very first instant
  // (no phase yet, <1s) — the pulsing dot + skeleton still convey life.
  const runningHint = running
    ? [toolPhaseText(step.phase), elapsed >= 1 ? `${elapsed}s` : null]
        .filter(Boolean)
        .join(" · ")
    : "";
  // web_search 的「N 条结果」是元计数（类比 read_url 组的「N 个来源」）：成功时并入标题行、
  // 不再另起一行 peek——顶层折叠态与「读取网页 · N 个来源」同构（单行 + 行尾 chevron）。
  const inlineCount =
    !nested &&
    step.tool_name === "web_search" &&
    step.status === "success" &&
    hasBody
      ? toolResultPeek(data)
      : null;
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
            <span
              className={
                nested
                  ? "text-sm text-foreground"
                  : "text-xs text-muted-foreground"
              }
            >
              <span className={nested ? "font-medium" : undefined}>{label}</span>
              {detail && (
                <span className="ml-1.5 break-all text-muted-foreground">
                  {detail}
                </span>
              )}
              {inlineCount && (
                <span className="ml-1.5 text-muted-foreground/70">
                  · {inlineCount}
                </span>
              )}
              <ToolRowTail
                status={step.status}
                nested={nested}
                hasBody={hasBody}
                open={open}
              />
            </span>
            {runningHint && (
              <span className="block truncate text-xs text-muted-foreground/70">
                {runningHint}
              </span>
            )}
            {hasBody && !open && !inlineCount && !suppressesPeek && (
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
  // All-read_url groups (≥2) render as a self-folding source collection — no
  // ToolLineGroup chevron on top (would be double disclosure). Persistence key
  // stays `${turnKey}:tgrp:${groupKey}` inside ReadUrlSourceCollection.
  if (isReadUrlSourceGroup(tools)) {
    return (
      <ReadUrlSourceCollection
        tools={tools}
        isStreaming={isStreaming}
        turnKey={turnKey}
        groupKey={groupKey}
      />
    );
  }
  return (
    <DefaultToolLineGroup
      tools={tools}
      isStreaming={isStreaming}
      turnKey={turnKey}
      groupKey={groupKey}
    />
  );
}

function DefaultToolLineGroup({
  tools,
  isStreaming,
  turnKey,
  groupKey,
}: {
  tools: Extract<ProcessStep, { kind: "tool" }>[];
  isStreaming: boolean;
  turnKey?: string;
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
        <span className="flex items-center gap-2">
          {running && <ThinkingDots />}
          <span className="min-w-0 truncate text-left">{summary}</span>
          {errorCount > 0 && (
            <Badge tone="destructive" className="shrink-0 font-normal">
              {errorCount} 个失败
            </Badge>
          )}
          {!running &&
            (expanded ? (
              <ChevronDown size={14} className="shrink-0" />
            ) : (
              <ChevronRight size={14} className="shrink-0" />
            ))}
        </span>
      </Button>
      {expanded && (
        <div className="mt-1.5 space-y-2 pl-3">
          {tools.map((t) => (
            <ToolLine key={t.id} step={t} turnKey={turnKey} nested />
          ))}
        </div>
      )}
    </div>
  );
}
