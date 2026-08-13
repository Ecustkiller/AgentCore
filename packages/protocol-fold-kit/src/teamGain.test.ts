import { describe, expect, it } from "vitest";
import {
  COLLAB_SUMMARY_TOOLTIP,
  formatCollabSummary,
  parallelSaving,
  parallelSavingText,
  parallelSavingTooltip,
  serialWorkMs,
} from "./index";

/** 两端 `formatDuration` 的同一份实现（apps/desktop lib/format · apps/mobile lib/time）。 */
function formatMs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m${s}s`;
}

const worker = (durationMs: number | null) => ({ kind: "agent", durationMs });

describe("serialWorkMs（各队员时长之和 = 一个接一个做要多久）", () => {
  it("captain 不计——它是对话本身，不是派出去的活", () => {
    expect(
      serialWorkMs([
        { kind: "captain", durationMs: 90_000 },
        worker(39_000),
        worker(42_000),
      ]),
    ).toBe(81_000);
  });

  it("缺时长 / 非正时长的 run 跳过", () => {
    expect(serialWorkMs([worker(null), worker(0), worker(5_000)])).toBe(5_000);
  });

  it("嵌套子团队不把重叠的那段数两遍（lead 的时长包着子队员的）", () => {
    // lead 跑 60s，其间两名子队员各 50s 并行。三个数直接相加 = 160s，可其中
    // 有 100s 是 lead「在等」的同一段时间——那正是虚高 savedMs 的出处。
    const runs = [
      { id: "lead", kind: "agent", durationMs: 60_000, parentRunId: null },
      { id: "sub1", kind: "agent", durationMs: 50_000, parentRunId: "lead" },
      { id: "sub2", kind: "agent", durationMs: 50_000, parentRunId: "lead" },
    ];
    expect(serialWorkMs(runs)).toBe(100_000);
  });

  it("子队员接力跑时 lead 自己那段仍算数（只扣重叠，不整只丢）", () => {
    const runs = [
      { id: "lead", kind: "agent", durationMs: 110_000, parentRunId: null },
      { id: "sub1", kind: "agent", durationMs: 50_000, parentRunId: "lead" },
      { id: "sub2", kind: "agent", durationMs: 50_000, parentRunId: "lead" },
    ];
    expect(serialWorkMs(runs)).toBe(110_000);
  });
});

describe("parallelSaving（并行省了多少）", () => {
  it("三人同时开工：串行 2m1s，实际等 42s → 省下 1m19s", () => {
    const saving = parallelSaving({
      elapsedMs: 42_000,
      runs: [worker(39_000), worker(40_000), worker(42_000)],
    });
    expect(saving).toEqual({
      savedMs: 79_000,
      serialMs: 121_000,
      elapsedMs: 42_000,
      workers: 3,
    });
    expect(parallelSavingText(saving!, formatMs)).toBe("同时开工省下 1m19s");
  });

  it("只派了一个人 → 沉默（没有并行可言）", () => {
    expect(
      parallelSaving({
        elapsedMs: 10_000,
        runs: [{ kind: "captain", durationMs: 90_000 }, worker(120_000)],
      }),
    ).toBeNull();
  });

  it("并行没产生节省（接力跑 / CEO 占大头）→ 沉默", () => {
    expect(
      parallelSaving({
        elapsedMs: 100_000,
        runs: [worker(40_000), worker(45_000)],
      }),
    ).toBeNull();
  });

  it("差值不足 1s → 沉默（不说「省下 0s」）", () => {
    expect(
      parallelSaving({
        elapsedMs: 60_000,
        runs: [worker(30_200), worker(30_400)],
      }),
    ).toBeNull();
  });

  it("没有跨度可比（用时 0 / 非法）→ 沉默", () => {
    const runs = [worker(30_000), worker(30_000)];
    expect(parallelSaving({ elapsedMs: 0, runs })).toBeNull();
    expect(parallelSaving({ elapsedMs: Number.NaN, runs })).toBeNull();
  });

  it("保守下界：CEO 的时间进 elapsed 不进 serial，宁可少报也不夸大", () => {
    // 队员并行 60s，回合总跨度 200s（CEO 拆解 + 汇总占 140s）。真串行回合会是 340s，
    // 但这里只按 180s − 200s 判定 → 沉默。少说不多说。
    expect(
      parallelSaving({
        elapsedMs: 200_000,
        runs: [worker(60_000), worker(60_000), worker(60_000)],
      }),
    ).toBeNull();
  });

  it("嵌套子团队：省下的那段按扣完重叠的工时算，不虚高", () => {
    const saving = parallelSaving({
      elapsedMs: 62_000,
      runs: [
        { id: "lead", kind: "agent", durationMs: 60_000, parentRunId: null },
        { id: "sub1", kind: "agent", durationMs: 50_000, parentRunId: "lead" },
        { id: "sub2", kind: "agent", durationMs: 50_000, parentRunId: "lead" },
      ],
    });
    // 老口径会算成 160s − 62s = 98s；扣掉 lead 与子队员重叠的那段后是 38s。
    expect(saving?.serialMs).toBe(100_000);
    expect(saving?.savedMs).toBe(38_000);
  });

  it("同一个人改了几版不是几位队员（接续链折成一位）→ 沉默", () => {
    // 一个人跑完被唤回重写两次：三个 run、一位队员，没有任何并行可言。
    expect(
      parallelSaving({
        elapsedMs: 30_000,
        runs: [
          { id: "r1", kind: "agent", durationMs: 30_000 },
          {
            id: "r1_rev1",
            kind: "agent",
            durationMs: 25_000,
            continuesRunId: "r1",
          },
          {
            id: "r1_rev2",
            kind: "agent",
            durationMs: 20_000,
            continuesRunId: "r1",
          },
        ],
      }),
    ).toBeNull();
  });

  it("tooltip 报的是人数，不是 run 数", () => {
    const saving = parallelSaving({
      elapsedMs: 40_000,
      runs: [
        { id: "r1", kind: "agent", durationMs: 40_000 },
        {
          id: "r1_rev1",
          kind: "agent",
          durationMs: 30_000,
          continuesRunId: "r1",
        },
        { id: "r2", kind: "agent", durationMs: 38_000 },
      ],
    })!;
    expect(saving.workers).toBe(2);
    expect(parallelSavingTooltip(saving, formatMs)).toContain("2 位队员");
  });
});

describe("诚实边界：基准是「同一批活串行」，不是「单个 AI」", () => {
  const saving = parallelSaving({
    elapsedMs: 42_000,
    runs: [worker(39_000), worker(40_000), worker(42_000)],
  })!;
  const surfaces = [
    parallelSavingText(saving, formatMs),
    parallelSavingTooltip(saving, formatMs),
  ];

  it("不出现「单 AI / 单个 AI」式的对比宣称", () => {
    // 我们没有「一个 AI 做同一件事要多久」的任何数据：它可能更快（无协调开销），
    // 也可能更慢（上下文塌陷）。任何把文案改成这种宣称的改动都要在这里红。
    for (const text of surfaces) {
      expect(text).not.toMatch(/单\s*个?\s*AI/);
      expect(text).not.toMatch(/倍/);
      expect(text).not.toMatch(/更聪明|更好|更强|质量更/);
    }
  });

  it("tooltip 明说基准是什么、不是什么", () => {
    const tip = parallelSavingTooltip(saving, formatMs);
    expect(tip).toContain("一个接一个");
    expect(tip).toContain("同时开工");
    expect(tip).toContain("不是拿一个 AI 做同一件事来比");
  });
});

describe("formatCollabSummary（队友互相挑出了几处）", () => {
  it("全为 0 / 缺省 → 沉默", () => {
    expect(formatCollabSummary(undefined)).toBeNull();
    expect(formatCollabSummary(null)).toBeNull();
    expect(
      formatCollabSummary({
        boundary_yields: 0,
        scope_signals: 0,
        revises: 0,
        escalations: 0,
      }),
    ).toBeNull();
  });

  it("换的是说法不是数：读起来是「互相把关」，不是四个负面内部计数", () => {
    const line = formatCollabSummary({
      boundary_yields: 2,
      scope_signals: 1,
      revises: 1,
      escalations: 4,
    });
    expect(line).toBe(
      "互相把关：发现跑偏 1 处 · 返工重写 1 处 · 中途改分工 2 次 · 先问再做 3 处",
    );
    // 旧口径的黑话不得回流。
    expect(line).not.toMatch(/纠偏|漂移|唤回|上报/);
  });

  it("scope 上报只数一次：escalations 已含 scope_signals，并列会重复计数", () => {
    // 3 次上报里 3 次都是跑偏 → 只说「发现跑偏 3 处」，不再另挂「先问再做 3 处」。
    expect(
      formatCollabSummary({
        boundary_yields: 0,
        scope_signals: 3,
        revises: 0,
        escalations: 3,
      }),
    ).toBe("互相把关：发现跑偏 3 处");
  });

  it("只有一项非零时只说那一项", () => {
    expect(
      formatCollabSummary({
        boundary_yields: 0,
        scope_signals: 0,
        revises: 2,
        escalations: 0,
      }),
    ).toBe("互相把关：返工重写 2 处");
  });

  it("audit_drops 等诊断字段不参与（多余键不影响判定）", () => {
    expect(
      formatCollabSummary({
        boundary_yields: 0,
        scope_signals: 0,
        revises: 0,
        escalations: 0,
        audit_drops: 3,
      } as never),
    ).toBeNull();
  });

  it("用户自己点的「立即改此人」不算队友互检", () => {
    // 3 次返工里 2 次是用户亲手点的热修——只有剩下 1 次是队友把关。
    expect(
      formatCollabSummary({
        boundary_yields: 0,
        scope_signals: 0,
        revises: 3,
        revises_by_user: 2,
        escalations: 0,
      }),
    ).toBe("互相把关：返工重写 1 处");
  });

  it("全都是用户自己点的 → 沉默（不许拿用户的动作给团队记功）", () => {
    expect(
      formatCollabSummary({
        boundary_yields: 1,
        boundary_yields_by_user: 1,
        scope_signals: 0,
        revises: 2,
        revises_by_user: 2,
        escalations: 0,
      }),
    ).toBeNull();
  });

  it("用户拍板的边界（计划复核）不算「中途改分工」", () => {
    expect(
      formatCollabSummary({
        boundary_yields: 3,
        boundary_yields_by_user: 1,
        scope_signals: 0,
        revises: 0,
        escalations: 0,
      }),
    ).toBe("互相把关：中途改分工 2 次");
  });

  it("缺 *_by_user 的旧数据照原样读（不因缺字段变负 / 变空）", () => {
    expect(
      formatCollabSummary({
        boundary_yields: 1,
        scope_signals: 0,
        revises: 2,
        escalations: 0,
      }),
    ).toBe("互相把关：返工重写 2 处 · 中途改分工 1 次");
  });

  it("tooltip 解释这些词，且不冒充质量评分", () => {
    expect(COLLAB_SUMMARY_TOOLTIP).toContain("发现跑偏");
    expect(COLLAB_SUMMARY_TOOLTIP).toContain("不是给结果打分");
    // 这一行只说队友做的事——把承诺写在用户读得到的地方。
    expect(COLLAB_SUMMARY_TOOLTIP).toContain("你自己点的");
  });
});
