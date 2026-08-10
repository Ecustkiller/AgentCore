"use client";

import { useEffect, useRef, useState } from "react";
import { useLang } from "@/components/LangProvider";
import { GRAPH } from "@/content/home";

/**
 * Hero 右侧的「协作图」——产品内协作画布的复刻。
 *
 * 叙事必须是 DAG，不是扇出并行子代理：
 *   你的任务 → ①摸底二人 → ②研判吃①产出 → ③质检（可打回）→ CEO 汇总
 *
 * 静态截图也要读得出「谁等谁」：波次分列 + worker→worker 依赖边 +
 * 质检→分析的打回虚线。时间线错开只是加分，不能替代拓扑。
 *
 * 动画由 120ms tick 驱动、状态从 elapsed 推导（不是一串 setTimeout）。
 */

const LOOP = 15_500;

/** 切换到宽几何的容器宽（px）。必须与 globals.css 里 @container 的 35rem 对齐。 */
const WIDE_AT = 560;

/**
 * 每个 worker 的时间线（ms，相对循环起点）。
 * 波次①（0,1）先并行；②（2,3）等①的产出才起步；③（4）最后进场质检。
 */
const TIMELINE = [
  { start: 600, run: 1600, done: 4200 },
  { start: 800, run: 1900, done: 4800 },
  { start: 4400, run: 5400, done: 7800 },
  { start: 4900, run: 5900, done: 8500 },
  { start: 8700, run: 9500, done: 11_600 },
];

const ALL_DONE = Math.max(...TIMELINE.map((w) => w.done));
const MERGE_UNTIL = ALL_DONE + 2000;

/** Agent 身份色：与站内协作图同一套，五个角色各占一格。 */
const TONES = [
  "--agent-1",
  "--agent-3",
  "--agent-6",
  "--agent-4",
  "--agent-8",
];

type Box = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };
type EdgeKind = "dispatch" | "dep" | "merge" | "challenge";
type EdgeDef = {
  id: string;
  kind: EdgeKind;
  /** 路径点（画布坐标） */
  pts: Pt[];
  /** 边何时「长」出来 / 何时流动 */
  litWhen: (stages: Stage[], ceoTone: CeoTone) => boolean;
  flowWhen: (stages: Stage[], ceoTone: CeoTone) => boolean;
};

type Geometry = {
  vw: number;
  vh: number;
  task: Box;
  workers: Box[];
  ceo: Box;
  /** 波次色带（仅装饰，宽几何用） */
  lanes: Box[];
  edges: EdgeDef[];
};

type Stage = "idle" | "thinking" | "running" | "done";
type CeoTone = "wait" | "merge" | "ready";

const midY = (b: Box) => b.y + b.h / 2;
const midX = (b: Box) => b.x + b.w / 2;
const right = (b: Box): Pt => ({ x: b.x + b.w, y: midY(b) });
const bottom = (b: Box): Pt => ({ x: midX(b), y: b.y + b.h });
const top = (b: Box): Pt => ({ x: midX(b), y: b.y });

/** 列间水平依赖：同排直连；跨排在中缝错开折点，避免多条边叠成一根「树干」。 */
function hPath(a: Box, b: Box, slot = 0.5): Pt[] {
  const y1 = midY(a);
  const y2 = midY(b);
  const leftX = a.x + a.w;
  const rightX = b.x;
  if (Math.abs(y1 - y2) < 1) {
    return [
      { x: leftX, y: y1 },
      { x: rightX, y: y2 },
    ];
  }
  const gap = rightX - leftX;
  const mx = leftX + gap * Math.min(0.85, Math.max(0.15, slot));
  return [
    { x: leftX, y: y1 },
    { x: mx, y: y1 },
    { x: mx, y: y2 },
    { x: rightX, y: y2 },
  ];
}

/** 同列上下：底出 → 顶进。 */
function vPath(a: Box, b: Box): Pt[] {
  const x1 = midX(a);
  const x2 = midX(b);
  const my = (a.y + a.h + b.y) / 2;
  return [
    { x: x1, y: a.y + a.h },
    { x: x1, y: my },
    { x: x2, y: my },
    { x: x2, y: b.y },
  ];
}

/** 打回：从质检左上绕过中缝上方回到分析右侧，不抢 CEO 那一列。 */
function challengePath(from: Box, to: Box): Pt[] {
  const start = { x: from.x, y: from.y + 18 };
  const end = right(to);
  const crest = Math.min(from.y, to.y) - 22;
  const dropX = end.x + 22;
  return [
    start,
    { x: start.x, y: crest },
    { x: dropX, y: crest },
    { x: dropX, y: end.y },
    end,
  ];
}

function buildEdges(
  task: Box,
  workers: Box[],
  ceo: Box,
  vertical: boolean,
): EdgeDef[] {
  const [w0, w1, w2, w3, w4] = workers;
  const lit = (i: number) => (s: Stage[]) => s[i] !== "idle";
  const flow = (i: number) => (s: Stage[]) =>
    s[i] === "thinking" || s[i] === "running";

  const dispatch = (i: number, pts: Pt[]): EdgeDef => ({
    id: `d-${i}`,
    kind: "dispatch",
    pts,
    litWhen: (s) => lit(i)(s),
    flowWhen: (s) => flow(i)(s),
  });
  const dep = (id: string, to: number, pts: Pt[]): EdgeDef => ({
    id,
    kind: "dep",
    pts,
    litWhen: (s) => lit(to)(s),
    flowWhen: (s) => flow(to)(s),
  });

  if (!vertical) {
    return [
      // 任务 → ①
      dispatch(0, hPath(task, w0)),
      dispatch(1, hPath(task, w1)),
      // ① → ②（分析吃两人产出；趋势吃采集）——折点错开，避免叠成一根树干
      dep("0-2", 2, hPath(w0, w2, 0.5)),
      dep("1-2", 2, hPath(w1, w2, 0.28)),
      dep("1-3", 3, hPath(w1, w3, 0.5)),
      // ② → ③
      dep("2-4", 4, hPath(w2, w4, 0.35)),
      dep("3-4", 4, hPath(w3, w4, 0.65)),
      // ③ → CEO（宽几何：CEO 独占右列，水平汇入）
      {
        id: "4-ceo",
        kind: "merge",
        pts: hPath(w4, ceo, 0.5),
        litWhen: (s, c) => s[4] === "done" || c !== "wait",
        flowWhen: (_s, c) => c === "merge",
      },
      // 质检打回分析
      {
        id: "chal",
        kind: "challenge",
        pts: challengePath(w4, w2),
        litWhen: (s) => s[4] === "running" || s[4] === "done",
        flowWhen: (s) => s[4] === "running",
      },
    ];
  }

  // 窄屏：上→下分层；①② 各两人并排。
  const taskTo = (w: Box): Pt[] => [
    bottom(task),
    { x: midX(task), y: (task.y + task.h + w.y) / 2 },
    { x: midX(w), y: (task.y + task.h + w.y) / 2 },
    top(w),
  ];
  const down = (a: Box, b: Box): Pt[] => {
    const my = (a.y + a.h + b.y) / 2;
    return [
      bottom(a),
      { x: midX(a), y: my },
      { x: midX(b), y: my },
      top(b),
    ];
  };
  // 打回走右侧沟，避免压住正向边。
  const chalNarrow: Pt[] = [
    right(w4),
    { x: 400, y: midY(w4) },
    { x: 400, y: midY(w2) },
    right(w2),
  ];

  return [
    dispatch(0, taskTo(w0)),
    dispatch(1, taskTo(w1)),
    dep("0-2", 2, down(w0, w2)),
    dep("1-2", 2, [
      bottom(w1),
      { x: midX(w1), y: (w1.y + w1.h + w2.y) / 2 },
      { x: midX(w2), y: (w1.y + w1.h + w2.y) / 2 },
      top(w2),
    ]),
    dep("1-3", 3, down(w1, w3)),
    dep("2-4", 4, down(w2, w4)),
    dep("3-4", 4, down(w3, w4)),
    {
      id: "4-ceo",
      kind: "merge",
      pts: vPath(w4, ceo),
      litWhen: (s, c) => s[4] === "done" || c !== "wait",
      flowWhen: (_s, c) => c === "merge",
    },
    {
      id: "chal",
      kind: "challenge",
      pts: chalNarrow,
      litWhen: (s) => s[4] === "running" || s[4] === "done",
      flowWhen: (s) => s[4] === "running",
    },
  ];
}

/* 宽屏：任务 | ① | ② | ③质检 | CEO — 中缝 ≥100，边与色带都有呼吸。 */
const WIDE: Geometry = (() => {
  const task = { x: 8, y: 152, w: 112, h: 80 };
  const workers = [
    { x: 156, y: 40, w: 152, h: 92 }, // ① 检索
    { x: 156, y: 264, w: 152, h: 92 }, // ① 采集
    { x: 420, y: 40, w: 152, h: 92 }, // ② 分析（中缝 112）
    { x: 420, y: 264, w: 152, h: 92 }, // ② 趋势
    { x: 684, y: 152, w: 152, h: 92 }, // ③ 质检
  ];
  const ceo = { x: 948, y: 152, w: 152, h: 92 };
  return {
    vw: 1120,
    vh: 396,
    task,
    workers,
    ceo,
    lanes: [
      { x: 140, y: 12, w: 184, h: 372 },
      { x: 404, y: 12, w: 184, h: 372 },
      { x: 668, y: 12, w: 184, h: 372 },
    ],
    edges: buildEdges(task, workers, ceo, false),
  };
})();

/* 窄屏：上 → 下分层；①② 并排，保住依赖形状。 */
const NARROW: Geometry = (() => {
  const task = { x: 112, y: 8, w: 196, h: 72 };
  const workers = [
    { x: 12, y: 104, w: 188, h: 92 },
    { x: 220, y: 104, w: 188, h: 92 },
    { x: 12, y: 248, w: 188, h: 92 },
    { x: 220, y: 248, w: 188, h: 92 },
    { x: 106, y: 392, w: 208, h: 92 },
  ];
  const ceo = { x: 106, y: 536, w: 208, h: 88 };
  return {
    vw: 420,
    vh: 640,
    task,
    workers,
    ceo,
    lanes: [],
    edges: buildEdges(task, workers, ceo, true),
  };
})();

/** 轴对齐折线 → 带圆角的 path。拐角半径受相邻线段长度约束，短段不会拱起来。 */
function orthPath(pts: Pt[], r = 12): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    const next = pts[i + 1];
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLen = Math.hypot(next.x - p.x, next.y - p.y);
    const rr = Math.min(r, inLen / 2, outLen / 2);
    const inDir = { x: Math.sign(p.x - prev.x), y: Math.sign(p.y - prev.y) };
    const outDir = { x: Math.sign(next.x - p.x), y: Math.sign(next.y - p.y) };
    d += ` L${p.x - inDir.x * rr} ${p.y - inDir.y * rr}`;
    d += ` Q${p.x} ${p.y} ${p.x + outDir.x * rr} ${p.y + outDir.y * rr}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x} ${last.y}`;
}

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

function stageOf(t: number, i: number): Stage {
  const w = TIMELINE[i];
  if (t < w.start) return "idle";
  if (t < w.run) return "thinking";
  if (t < w.done) return "running";
  return "done";
}

export default function CollabGraph() {
  const { t: tr } = useLang();
  const hostRef = useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = useState(0);
  // 首屏按宽屏渲染，挂载后再按实际容器切——与 SSR 输出一致，不会 hydration 打架。
  const [wide, setWide] = useState(true);

  /*
   * 几何按「容器宽」切，不是视口宽。
   * Hero 在 xl 以上是两栏，右栏比视口窄得多；
   * 阈值必须与 globals.css 里 @container 的 35rem 一致。
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(([entry]) =>
      setWide(entry.contentRect.width >= WIDE_AT),
    );
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    // 降级：停在「全员交付、CEO 汇总完成」——静态也讲得完 DAG 故事。
    if (reduced.matches) {
      setElapsed(MERGE_UNTIL + 600);
      return;
    }

    let timer: number | undefined;
    const start = performance.now();
    const tick = () => setElapsed((performance.now() - start) % LOOP);
    const run = () => {
      if (timer) return;
      timer = window.setInterval(tick, 120);
    };
    const stop = () => {
      if (!timer) return;
      window.clearInterval(timer);
      timer = undefined;
    };

    // Hero 首屏先跑：部分环境 IntersectionObserver 首回调会晚一拍，
    // 若等回调才 start，静态首屏会停在 t=0（无边激活、像清单）。
    run();
    const host = hostRef.current;
    const io = host
      ? new IntersectionObserver(
          ([entry]) => (entry.isIntersecting ? run() : stop()),
          { threshold: 0.05 },
        )
      : null;
    if (io && host) io.observe(host);

    const onVisibility = () =>
      document.hidden ? stop() : hostRef.current && run();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const g = wide ? WIDE : NARROW;
  const stages = TIMELINE.map((_, i) => stageOf(elapsed, i));
  const doneCount = stages.filter((s) => s === "done").length;
  const secs = (from: number) => Math.max(0, Math.round((elapsed - from) / 1000));

  const ceoTone: CeoTone =
    elapsed < ALL_DONE ? "wait" : elapsed < MERGE_UNTIL ? "merge" : "ready";
  const ceoLabel =
    ceoTone === "wait"
      ? `${tr(GRAPH.ceo.waiting)} (${doneCount}/${TIMELINE.length}) · ${tr(GRAPH.ceo.elapsed)} ${secs(TIMELINE[0].start)}s`
      : ceoTone === "merge"
        ? `${tr(GRAPH.ceo.merging)} · ${secs(ALL_DONE)}s`
        : tr(GRAPH.ceo.ready);

  return (
    <div ref={hostRef} className="cg-shell">
      <div className="cg-toolbar">
        <span className="font-semibold">{tr(GRAPH.toolbarTitle)}</span>
        <span className="flex items-center gap-1.5">
          <span className="cg-chip" style={{ color: "oklch(0.55 0.1 25)" }}>
            <span aria-hidden="true">■</span>
            {tr(GRAPH.toolbarStop)}
          </span>
          <span className="cg-chip">{tr(GRAPH.toolbarView)}</span>
        </span>
      </div>

      <div className="cg" style={{ aspectRatio: `${g.vw} / ${g.vh}` }}>
        <div aria-hidden="true" className="cg-canvas" />

        {/* 波次色带：把「按依赖分波」做成空间结构，不只靠角标 */}
        {g.lanes.map((lane, i) => (
          <div
            key={`lane-${i}`}
            aria-hidden="true"
            className="cg-lane"
            style={{
              left: pct(lane.x, g.vw),
              top: pct(lane.y, g.vh),
              width: pct(lane.w, g.vw),
              height: pct(lane.h, g.vh),
            }}
          >
            <span className="cg-lane-label">{["①", "②", "③"][i]}</span>
          </div>
        ))}

        <svg
          aria-hidden="true"
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${g.vw} ${g.vh}`}
          fill="none"
        >
          {g.edges.map((edge) => {
            const on = edge.litWhen(stages, ceoTone);
            const flowing = edge.flowWhen(stages, ceoTone);
            const d = orthPath(edge.pts, edge.kind === "challenge" ? 10 : 12);
            return (
              <g key={edge.id}>
                <path
                  d={d}
                  className={`cg-edge cg-edge-${edge.kind} ${on ? "is-on" : ""}`}
                />
                {flowing && (
                  <path
                    d={d}
                    className={`cg-flow ${edge.kind === "challenge" ? "is-challenge" : ""}`}
                  />
                )}
              </g>
            );
          })}
        </svg>

        {/* 你的任务 */}
        <div
          className="cg-node cg-node-task"
          style={{
            left: pct(g.task.x, g.vw),
            top: pct(g.task.y, g.vh),
            width: pct(g.task.w, g.vw),
            height: pct(g.task.h, g.vh),
          }}
        >
          <div className="flex items-center gap-[0.55em]">
            <span className="cg-avatar cg-avatar-user" aria-hidden="true">
              <svg viewBox="0 0 16 16" className="w-[0.85em]" fill="currentColor">
                <circle cx="8" cy="5" r="2.8" />
                <path d="M2.6 14a5.4 5.4 0 0 1 10.8 0z" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="cg-title">{tr(GRAPH.task.title)}</p>
              <p className="cg-sub">{tr(GRAPH.task.sub)}</p>
            </div>
          </div>
          <p className="cg-meta">{tr(GRAPH.toolbarTitle)}</p>
        </div>

        {g.workers.map((box, i) => {
          const stage = stages[i];
          const spec = GRAPH.workers[i];
          const active = stage === "thinking" || stage === "running";
          const note = tr(spec.note);
          const typed =
            stage === "running"
              ? note.slice(
                  0,
                  Math.max(
                    1,
                    Math.round(
                      ((elapsed - TIMELINE[i].run) /
                        (TIMELINE[i].done - TIMELINE[i].run)) *
                        note.length *
                        1.35,
                    ),
                  ),
                )
              : stage === "done"
                ? note
                : "";

          return (
            <div
              key={i}
              className={`cg-node cg-node-worker ${active ? "is-active" : ""} ${
                stage === "done" ? "is-done" : ""
              } ${stage === "idle" ? "is-idle" : ""}`}
              style={{
                left: pct(box.x, g.vw),
                top: pct(box.y, g.vh),
                width: pct(box.w, g.vw),
                height: pct(box.h, g.vh),
              }}
            >
              <div className="flex items-center gap-[0.5em]">
                <span
                  className="cg-avatar"
                  aria-hidden="true"
                  style={{
                    background: `color-mix(in oklab, var(${TONES[i]}), white 72%)`,
                    color: `color-mix(in oklab, var(${TONES[i]}), black 34%)`,
                  }}
                >
                  {tr(spec.name).slice(0, 1)}
                </span>
                <p className="cg-title">{tr(spec.name)}</p>
                <span className="cg-wave" aria-hidden="true">
                  {spec.wave}
                </span>
                <span className="flex-1" />
                {stage === "done" && (
                  <span className="cg-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </div>

              <p className={`cg-status ${stage === "done" ? "is-done" : ""}`}>
                {stage === "idle"
                  ? tr(GRAPH.queued)
                  : stage === "thinking"
                    ? `${tr(GRAPH.thinking)} · ${secs(TIMELINE[i].start)}s`
                    : stage === "running"
                      ? `${spec.tool} · ${secs(TIMELINE[i].start)}s`
                      : `${tr(GRAPH.finished)} · ${Math.round((TIMELINE[i].done - TIMELINE[i].start) / 1000)}s`}
              </p>

              <p className="cg-note">
                {typed}
                {stage === "running" && <span className="cg-caret" />}
              </p>
            </div>
          );
        })}

        <div
          className={`cg-node cg-node-ceo ${ceoTone === "ready" ? "is-done" : "is-active"}`}
          style={{
            left: pct(g.ceo.x, g.vw),
            top: pct(g.ceo.y, g.vh),
            width: pct(g.ceo.w, g.vw),
            height: pct(g.ceo.h, g.vh),
          }}
        >
          <div className="flex items-center gap-[0.55em]">
            <span className="cg-avatar cg-avatar-ceo" aria-hidden="true">
              {ceoTone === "ready" ? "✓" : <span className="cg-spin" />}
            </span>
            <p className="cg-title flex-1">{tr(GRAPH.ceo.title)}</p>
          </div>
          <p className={`cg-status ${ceoTone === "ready" ? "is-done" : ""}`}>
            {ceoLabel}
          </p>
          <p className="cg-note not-italic">{tr(GRAPH.ceo.body)}</p>
        </div>
      </div>
    </div>
  );
}
