import { Button } from "@/components/ui";
import { formatCompact, formatCost, formatUsd } from "@/lib/format";
import { usePersistentDisclosure } from "@/stores/disclosure";
import {
  type AgentState,
  MODEL_TIER_META,
  type RunNode,
  reasoningMeta,
} from "@/stores/execution";
import { ChevronDown, ChevronRight } from "lucide-react";
import { MetricRow } from "./shared";

/**
 * Per-run resource ledger (§7.3B power detail) — the single place a run's full
 * raw token + cost breakdown lives. Defaults expanded. All-zero cost renders as
 * 「—」(§7.5), not「¥0.00」.
 */
export function ResourceSection({
  run,
  agent,
  cnyPerUsd,
  defaultExpanded,
  keyBase,
}: {
  run: RunNode;
  agent: AgentState;
  cnyPerUsd: number;
  defaultExpanded: boolean;
  keyBase: string;
}) {
  const [expanded, setExpanded] = usePersistentDisclosure(
    `${keyBase}:resources`,
    defaultExpanded,
  );
  const { usage, cost, model } = run;
  const cacheRate =
    usage && usage.input > 0
      ? Math.round((usage.cache_hit / usage.input) * 100)
      : 0;

  return (
    <section className="mb-4 last:mb-0">
      <Button
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="h-auto w-full justify-start gap-1.5 px-0 py-0 hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-1.5">
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="flex-1 text-left text-xs font-medium text-muted-foreground">
            资源消耗
          </span>
          {cost && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatCost(cost.total, cnyPerUsd)}
            </span>
          )}
        </span>
      </Button>

      {expanded && (
        <div className="mt-2 space-y-2 rounded-lg bg-muted p-3">
          <MetricRow
            label="档位"
            value={MODEL_TIER_META[agent.modelPreference].label}
          />
          <MetricRow
            label="思考"
            value={reasoningMeta(agent.thinking, agent.reasoningEffort).label}
          />
          {model && <MetricRow label="模型" value={model} mono />}

          {cost && (
            <div>
              <MetricRow
                label="成本"
                value={`${formatCost(cost.total, cnyPerUsd)} · ${formatUsd(cost.total)}`}
              />
              <p className="mt-0.5 text-xs text-muted-foreground">
                输入 {formatUsd(cost.input)} · 输出 {formatUsd(cost.output)}
                {cost.cached > 0 && <> · 缓存省 {formatUsd(cost.cached)}</>}
              </p>
            </div>
          )}

          {usage && (
            <>
              <div>
                <MetricRow
                  label="输入 token"
                  value={formatCompact(usage.input)}
                />
                <p className="mt-0.5 text-xs text-muted-foreground">
                  命中 {formatCompact(usage.cache_hit)} · 未命中{" "}
                  {formatCompact(usage.cache_miss)} · 缓存率 {cacheRate}%
                </p>
              </div>
              <div>
                <MetricRow
                  label="输出 token"
                  value={formatCompact(usage.output)}
                />
                <p className="mt-0.5 text-xs text-muted-foreground">
                  推理 {formatCompact(usage.reasoning)}
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
