import { InteractionSheet } from "@/components/InteractionSheet";
import { FINISH_REASON_META } from "@/lib/errors";
import {
  type MessageCopyMode,
  copyText,
  formatMessageExport,
} from "@/lib/messageExport";
import {
  type SupportDiagnosticIds,
  formatSupportDiagnosticText,
} from "@/lib/supportDiagnostics";
import { formatDuration, formatMessageTime } from "@/lib/time";
import type { ProcessStep, UsageBreakdown } from "@agentcore/contract-types";
import { useState } from "react";
import "./AssistantMessageFooter.css";

function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function cacheRatePercent(usage: UsageBreakdown): number | null {
  if (usage.input <= 0) return null;
  return Math.round((usage.cache_hit / usage.input) * 100);
}

/** Compact token / round / cost / duration — right-side footer meta. */
function UsageSummary({
  usage,
  rounds,
  costText,
  durationMs,
  clockIso,
}: {
  usage?: UsageBreakdown | null;
  rounds?: number | null;
  costText?: string | null;
  durationMs?: number | null;
  clockIso?: string | null;
}) {
  const durationText =
    durationMs != null && durationMs > 0 ? formatDuration(durationMs) : null;
  const clockLabel = clockIso ? formatMessageTime(clockIso) : "";
  if (
    !usage &&
    (rounds == null || rounds <= 1) &&
    !costText &&
    !durationText &&
    !clockLabel
  ) {
    return null;
  }

  const rate = usage ? cacheRatePercent(usage) : null;
  const parts: string[] = [];
  if (usage) {
    const inPart = `↑${formatCompact(usage.input)}${rate != null && rate > 0 ? `(缓${rate}%)` : ""}`;
    const outPart = `↓${formatCompact(usage.output)}${usage.reasoning > 0 ? `(思${formatCompact(usage.reasoning)})` : ""}`;
    parts.push(`${inPart} ${outPart}`);
  }
  if (rounds != null && rounds > 1) parts.push(`${rounds} 轮`);
  if (costText) parts.push(costText);
  if (durationText) parts.push(`用时 ${durationText}`);
  if (clockLabel) parts.push(clockLabel);

  return (
    <div className="amf-usage" data-testid="assistant-usage-summary">
      {parts.join(" · ")}
    </div>
  );
}

function UsageDetailRows({ usage }: { usage: UsageBreakdown }) {
  const rate = cacheRatePercent(usage);
  return (
    <div className="amf-usage-detail">
      <div className="amf-usage-row">
        <span>输入</span>
        <span className="amf-usage-val">{formatCompact(usage.input)}</span>
      </div>
      <div className="amf-usage-row">
        <span>缓存命中</span>
        <span className="amf-usage-val">
          {formatCompact(usage.cache_hit)}
          {rate != null ? ` · ${rate}%` : ""}
        </span>
      </div>
      <div className="amf-usage-row">
        <span>缓存未命中</span>
        <span className="amf-usage-val">{formatCompact(usage.cache_miss)}</span>
      </div>
      <div className="amf-usage-row">
        <span>输出</span>
        <span className="amf-usage-val">{formatCompact(usage.output)}</span>
      </div>
      {usage.reasoning > 0 && (
        <div className="amf-usage-row">
          <span>思考</span>
          <span className="amf-usage-val">
            {formatCompact(usage.reasoning)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Assistant bubble footer — copy strategy + usage/cost/duration hierarchy.
 * 赞踩 / 收藏：手机尚无 client API 封装，不做假 UI（后端 REST 存在亦不在此接线）。
 * 「更多」走 Sheet(A) 用量明细 / 收尾原因 / 排查包。
 */
export function AssistantMessageFooter({
  content,
  process,
  supportIds,
  usage,
  rounds,
  costText,
  durationMs,
  clockIso,
  finishReason,
  isStreaming = false,
}: {
  content: string;
  process?: ProcessStep[];
  supportIds?: SupportDiagnosticIds;
  usage?: UsageBreakdown | null;
  rounds?: number | null;
  costText?: string | null;
  durationMs?: number | null;
  clockIso?: string | null;
  finishReason?: string | null;
  isStreaming?: boolean;
}) {
  const [copied, setCopied] = useState<MessageCopyMode | "support" | null>(
    null,
  );
  const [moreOpen, setMoreOpen] = useState(false);

  const supportText = supportIds ? formatSupportDiagnosticText(supportIds) : "";
  const hasContent = !!content.trim() || (process && process.length > 0);
  const hasProcess = (process?.length ?? 0) > 0;
  const finishLabel = finishReason
    ? FINISH_REASON_META[finishReason]?.label
    : null;
  const hasMore =
    !!usage || !!finishLabel || !!supportText || (rounds != null && rounds > 1);

  // Streaming: only lightweight copy when there is body text (usage meaningless mid-stream).
  if (isStreaming) {
    if (!hasContent || !content.trim()) return null;
    const onCopy = async (mode: MessageCopyMode) => {
      const text = formatMessageExport(content, process, mode);
      if (await copyText(text)) {
        setCopied(mode);
        window.setTimeout(() => setCopied(null), 1500);
      }
    };
    return (
      <div className="amf" data-testid="assistant-message-footer">
        <div className="amf-actions">
          <button
            type="button"
            className="amf-btn"
            onClick={() => void onCopy("deliverable")}
          >
            {copied === "deliverable" ? "已复制" : "复制交付"}
          </button>
          {hasProcess && (
            <button
              type="button"
              className="amf-btn"
              onClick={() => void onCopy("with_process")}
            >
              {copied === "with_process" ? "已复制" : "含过程"}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!hasContent && !supportText && !usage && !costText && !durationMs) {
    return null;
  }

  const onCopy = async (mode: MessageCopyMode) => {
    const text = formatMessageExport(content, process, mode);
    if (await copyText(text)) {
      setCopied(mode);
      window.setTimeout(() => setCopied(null), 1500);
    }
  };

  const onCopySupport = async () => {
    if (!supportText) return;
    if (await copyText(supportText)) {
      setCopied("support");
      window.setTimeout(() => setCopied(null), 1500);
    }
  };

  return (
    <div className="amf" data-testid="assistant-message-footer">
      <div className="amf-actions">
        {hasContent && (
          <button
            type="button"
            className="amf-btn"
            onClick={() => void onCopy("deliverable")}
          >
            {copied === "deliverable" ? "已复制" : "复制交付"}
          </button>
        )}
        {hasContent && hasProcess && (
          <button
            type="button"
            className="amf-btn"
            onClick={() => void onCopy("with_process")}
          >
            {copied === "with_process" ? "已复制" : "含过程"}
          </button>
        )}
        {hasMore && (
          <button
            type="button"
            className="amf-btn"
            onClick={() => setMoreOpen(true)}
            data-testid="assistant-footer-more"
          >
            更多
          </button>
        )}
      </div>
      <UsageSummary
        usage={usage}
        rounds={rounds}
        costText={costText}
        durationMs={durationMs}
        clockIso={clockIso}
      />
      {moreOpen && (
        <InteractionSheet
          title="消息详情"
          label="消息详情"
          onCollapse={() => setMoreOpen(false)}
          footer={
            <button
              type="button"
              className="amf-sheet-done"
              onClick={() => setMoreOpen(false)}
            >
              完成
            </button>
          }
        >
          {usage && (
            <>
              <div className="amf-sheet-label">用量详情</div>
              <UsageDetailRows usage={usage} />
              {rounds != null && rounds > 1 && (
                <div className="amf-usage-row amf-usage-row-pad">
                  <span>ReAct 轮次</span>
                  <span className="amf-usage-val">{rounds} 轮</span>
                </div>
              )}
            </>
          )}
          {finishLabel && (
            <>
              <div className="amf-sheet-label">收尾原因</div>
              <p className="amf-sheet-text">{finishLabel}</p>
            </>
          )}
          {supportText && (
            <button
              type="button"
              className="amf-btn amf-btn-block"
              onClick={() => void onCopySupport()}
            >
              {copied === "support" ? "已复制" : "复制排查包"}
            </button>
          )}
        </InteractionSheet>
      )}
    </div>
  );
}

/** Top-of-bubble chip for abnormal turn endings. */
export function FinishReasonChip({
  reason,
  diagnosisLabel,
}: {
  reason: string | null | undefined;
  diagnosisLabel?: string;
}) {
  const meta = reason ? FINISH_REASON_META[reason] : undefined;
  if (!meta) return null;
  const label =
    reason === "degraded" && diagnosisLabel
      ? `降级完成 · ${diagnosisLabel}`
      : meta.label;
  return (
    <div className="finish-chip" data-testid="finish-reason-chip">
      {label}
    </div>
  );
}

/** 交付轻提示（对齐桌面 DeliveryStatusMount）：partial/blocked 一句。 */
export function DeliveryShortfallHint({
  status,
}: {
  status: { state: string; summary: string } | null | undefined;
}) {
  if (!status) return null;
  if (status.state !== "partial" && status.state !== "blocked") return null;
  const text =
    status.summary.trim() ||
    (status.state === "blocked" ? "交付未满足" : "部分交付未满足");
  return (
    <p
      className="delivery-shortfall-hint"
      data-testid="delivery-shortfall-hint"
    >
      {text}
    </p>
  );
}
