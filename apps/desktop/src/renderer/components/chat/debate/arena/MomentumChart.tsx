import type { DebateRoundModel } from "../model";

/** 逐轮各方得分小条（chess.com 评估条风格）。无记分轮隐藏。 */
export function MomentumChart({
  rounds,
  sideKeys,
  colorByKey,
}: {
  rounds: DebateRoundModel[];
  sideKeys: string[];
  colorByKey: Record<string, string>;
}) {
  const scored = rounds.filter((r) => r.scores.length > 0);
  if (scored.length === 0 || sideKeys.length === 0) return null;

  const maxAbs = Math.max(
    1,
    ...scored.flatMap((r) => r.scores.map((s) => Math.abs(s.total))),
  );

  return (
    <div
      className="flex items-end gap-0.5"
      aria-label="逐轮得分动量"
      title="逐轮各方得分"
    >
      {scored.map((r) => (
        <div key={r.roundNo} className="flex flex-col items-center gap-0.5">
          <div className="flex h-6 items-end gap-px">
            {sideKeys.map((key) => {
              const score = r.scores.find((s) => s.sideKey === key);
              const val = score?.total ?? 0;
              const h =
                val !== 0 ? Math.max(2, (Math.abs(val) / maxAbs) * 24) : 2;
              return (
                <span
                  key={key}
                  className="w-1.5 rounded-lg"
                  style={{
                    height: h,
                    backgroundColor: colorByKey[key],
                    opacity: val === 0 ? 0.25 : 1,
                  }}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
