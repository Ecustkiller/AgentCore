import { describeError } from "@/lib/errors";
import {
  getSimulationMetrics,
  type SimTickMetrics,
} from "@/services/simulation/api";
import {
  computeRegionStats,
  moodBand,
  moodBandClass,
} from "@/simulation/regionStats";
import { useSimulationView } from "@/simulation/viewState";
import { useSimulationUiStore } from "@/simulation/store/simulationStore";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type ChartRow = {
  tick: number;
  avgMood: number;
  tradeTotal: number;
  relationDensity: number;
  population: number;
};

function seriesToChartRows(series: SimTickMetrics[]): ChartRow[] {
  return series.map((row) => ({
    tick: row.tick,
    avgMood: row.avg_mood,
    tradeTotal: row.trade_total_amount,
    relationDensity: row.positive_relation_ratio,
    population: Object.values(row.population_by_region).reduce(
      (sum, n) => sum + n,
      0,
    ),
  }));
}

function RegionCard({
  label,
  population,
  populationRatio,
  avgMood,
}: {
  label: string;
  population: number;
  populationRatio: number;
  avgMood: number;
}) {
  const band = moodBand(avgMood);
  const pct = Math.round(populationRatio * 100);

  return (
    <article className="rounded-xl border border-border bg-background p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span
          className={`h-3 w-3 shrink-0 rounded-full ${moodBandClass(band)}`}
          title={`平均情绪 ${avgMood.toFixed(2)}`}
          aria-label={`情绪：${band === "good" ? "良好" : band === "bad" ? "较差" : "一般"}`}
        />
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="font-mono text-base tabular-nums text-foreground">
          {population}
        </span>
        <span className="text-xs text-muted-foreground">人</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary/70 transition-[width]"
          style={{ width: `${Math.max(pct, population > 0 ? 4 : 0)}%` }}
        />
      </div>
      <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
        {pct}% · 情绪 {avgMood >= 0 ? "+" : ""}
        {avgMood.toFixed(2)}
      </p>
    </article>
  );
}

export function ObservationPanel() {
  const run = useSimulationUiStore((s) => s.run);
  const { viewTick, viewAgents } = useSimulationView();

  const regionStats = useMemo(() => computeRegionStats(viewAgents), [viewAgents]);

  const [metricsSeries, setMetricsSeries] = useState<SimTickMetrics[]>([]);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);

  const refreshMetrics = useCallback(async () => {
    if (!run?.id) return;
    setMetricsLoading(true);
    try {
      const res = await getSimulationMetrics(run.id);
      setMetricsSeries(res.metrics ?? []);
      setMetricsError(null);
    } catch (err) {
      setMetricsError(describeError(err)?.message ?? "指标加载失败");
    } finally {
      setMetricsLoading(false);
    }
  }, [run?.id]);

  useEffect(() => {
    void refreshMetrics();
  }, [refreshMetrics, run?.tick]);

  const chartData = useMemo(
    () => seriesToChartRows(metricsSeries),
    [metricsSeries],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">区域热力图</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Tick {viewTick} · 7 个区域实时人口与情绪
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {regionStats.map((region) => (
            <RegionCard
              key={region.id}
              label={region.label}
              population={region.population}
              populationRatio={region.populationRatio}
              avgMood={region.avgMood}
            />
          ))}
        </div>
      </section>

      <section className="px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">宏观指标</h3>
          <button
            type="button"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => void refreshMetrics()}
            disabled={metricsLoading}
          >
            {metricsLoading ? "刷新中…" : "刷新"}
          </button>
        </div>
        {metricsError ? (
          <p className="mt-2 text-xs text-destructive">{metricsError}</p>
        ) : chartData.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {metricsLoading
              ? "加载指标…"
              : "推进 tick 后显示情绪、交易、关系密度时序。"}
          </p>
        ) : (
          <div className="mt-3 h-52 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 4, right: 8, left: -16, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="tick"
                  tick={{ fontSize: 10 }}
                  className="fill-muted-foreground"
                />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--card)",
                  }}
                  labelFormatter={(tick) => `Tick ${tick}`}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="avgMood"
                  name="情绪均值"
                  stroke="var(--success)"
                  dot={false}
                  strokeWidth={1.5}
                />
                <Line
                  type="monotone"
                  dataKey="tradeTotal"
                  name="交易总量"
                  stroke="var(--primary)"
                  dot={false}
                  strokeWidth={1.5}
                />
                <Line
                  type="monotone"
                  dataKey="relationDensity"
                  name="关系密度"
                  stroke="var(--warning)"
                  dot={false}
                  strokeWidth={1.5}
                />
                <Line
                  type="monotone"
                  dataKey="population"
                  name="区域人口"
                  stroke="var(--muted-foreground)"
                  dot={false}
                  strokeWidth={1.5}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  );
}
