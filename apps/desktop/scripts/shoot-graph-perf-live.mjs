// Live CDP collaboration-graph jank probe: attach to a running electron-vite
// dev app over remoteDebuggingPort, record per-second rAF gaps / longtasks /
// __graphPerf / ReactFlow inventory while you reproduce jank (or walk --cid).
//
// Unlike shoot:graph-perf (offline #/preview, ≤9 nodes, never hits ELK), this
// samples the real running app — the only way to catch production-like drops.
//
// Prerequisite — start the desktop app with CDP enabled:
//   pnpm -C apps/desktop exec electron-vite dev --remoteDebuggingPort=9222
//
// Usage:
//   pnpm -C apps/desktop shoot:graph-perf-live
//   pnpm -C apps/desktop shoot:graph-perf-live -- 120
//   pnpm -C apps/desktop shoot:graph-perf-live -- --port 9222 --duration 180
//   pnpm -C apps/desktop shoot:graph-perf-live -- --cid <uuid> [--cid <uuid>...]
//
// Args / flags:
//   [durationSec]     record length (default 120); positional or --duration
//   --cdp <url>       CDP endpoint (default http://127.0.0.1:9222)
//   --port <n>        shorthand → http://127.0.0.1:<n>
//   --out <file>      JSON path (default shoot-out-graph-perf/live-<stamp>.json)
//   --cid <id>        navigate to conversation(s) during recording (repeatable)
//   --settle-ms <n>   wait after each --cid hash change (default 4000)
//   --no-raise        skip Win32 raise-to-foreground helper
//
// Drop detection uses a measured native frame interval (not hardcoded 16.7ms).
// Occluded/background Chromium throttles rAF to ~1Hz while visibilityState may
// still read "visible" — those seconds are flagged and excluded from aggregates.
//
// Writes JSON under shoot-out-graph-perf/.

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const outDir = resolve(desktopDir, "shoot-out-graph-perf");
const raiseScript = resolve(here, "raise-electron-window.ps1");

function parseArgs(argv) {
  const opts = {
    durationSec: 120,
    cdp: "http://127.0.0.1:9222",
    out: null,
    cids: [],
    settleMs: 4000,
    raise: true,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cdp") opts.cdp = argv[++i];
    else if (a === "--port") opts.cdp = `http://127.0.0.1:${argv[++i]}`;
    else if (a === "--duration") opts.durationSec = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--cid") opts.cids.push(argv[++i]);
    else if (a === "--settle-ms") opts.settleMs = Number(argv[++i]);
    else if (a === "--no-raise") opts.raise = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else pos.push(a);
  }
  if (pos[0] != null && !Number.isNaN(Number(pos[0]))) {
    opts.durationSec = Number(pos[0]);
  }
  if (!Number.isFinite(opts.durationSec) || opts.durationSec <= 0) {
    throw new Error(`invalid durationSec: ${opts.durationSec}`);
  }
  return opts;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[i] ?? 0;
}

/** @param {number[]} gaps @param {number} dropThresholdMs */
function stats(gaps, dropThresholdMs) {
  if (!gaps.length) {
    return { n: 0, p50: 0, p95: 0, p99: 0, max: 0, dropped: 0, dropThresholdMs };
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const p50 = Math.round(pct(sorted, 50) * 10) / 10;
  return {
    n: gaps.length,
    p50,
    p95: Math.round(pct(sorted, 95) * 10) / 10,
    p99: Math.round(pct(sorted, 99) * 10) / 10,
    max: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
    dropped: gaps.filter((v) => v > dropThresholdMs).length,
    dropThresholdMs: Math.round(dropThresholdMs * 10) / 10,
  };
}

function raiseElectronWindow() {
  if (process.platform !== "win32") {
    console.log("[live-perf] raise helper is Windows-only; relying on CDP bringToFront");
    return { ok: false, reason: "non-win32" };
  }
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", raiseScript],
    { encoding: "utf8", windowsHide: true },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (out) console.log("[live-perf] raise:", out.split(/\r?\n/).join(" | "));
  return { ok: r.status === 0, status: r.status, out };
}

const RECORDER = () => {
  if (window.__liveGraphPerf?.installed) return "already";
  const state = {
    installed: true,
    buckets: [],
    current: null,
    longTasks: [],
  };
  const newBucket = (t) => ({
    t,
    gaps: [],
    longTasks: 0,
    longTaskMaxMs: 0,
    hiddenFrames: 0,
  });
  state.current = newBucket(Date.now());

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.current.longTasks += 1;
        state.current.longTaskMaxMs = Math.max(
          state.current.longTaskMaxMs,
          Math.round(e.duration),
        );
        state.longTasks.push({
          at: Date.now(),
          ms: Math.round(e.duration),
        });
      }
    }).observe({ type: "longtask", buffered: false });
  } catch {
    /* not supported */
  }

  let last = performance.now();
  const tick = (now) => {
    const gap = now - last;
    last = now;
    const b = state.current;
    b.gaps.push(Math.round(gap * 10) / 10);
    if (document.visibilityState !== "visible") b.hiddenFrames += 1;
    if (Date.now() - b.t >= 1000) {
      state.buckets.push(b);
      if (state.buckets.length > 3600) state.buckets.shift();
      state.current = newBucket(Date.now());
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__liveGraphPerf = state;
  window.__graphPerf?.(true);
  return "installed";
};

const DRAIN = () => {
  const s = window.__liveGraphPerf;
  if (!s) return null;
  const out = s.buckets.splice(0, s.buckets.length);
  return {
    buckets: out,
    inv: {
      hash: location.hash,
      visibility: document.visibilityState,
      focus: document.hasFocus(),
      domNodes: document.querySelectorAll("*").length,
      reactFlows: document.querySelectorAll(".react-flow").length,
      graphNodes: document.querySelectorAll(".react-flow__node").length,
      graphEdges: document.querySelectorAll(".react-flow__edge").length,
      anims: document.getAnimations().length,
      animTop: Object.entries(
        document.getAnimations().reduce((acc, a) => {
          const k = a.animationName || a.transitionProperty || a.constructor.name;
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {}),
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
      smil: document.querySelectorAll("animateMotion, animate, animateTransform")
        .length,
      pulse: document.querySelectorAll(".animate-pulse").length,
      spin: document.querySelectorAll(".animate-spin").length,
      heapMB: performance.memory
        ? Math.round(performance.memory.usedJSHeapSize / 1048576)
        : null,
    },
    perf: window.__graphPerf?.summary?.() ?? null,
  };
};

async function sampleRafGaps(page, durationMs) {
  return page.evaluate(async (ms) => {
    const out = [];
    let last = performance.now();
    const start = last;
    await new Promise((resolve) => {
      const step = (now) => {
        out.push(now - last);
        last = now;
        if (now - start >= ms) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    return out;
  }, durationMs);
}

/**
 * Measure idle rAF gaps to establish display refresh + drop threshold.
 * Retries with raise — Cursor/IDE often steals focus and Chromium then
 * throttles rAF to ~1Hz (gaps ≈1000ms), which must not become the baseline.
 */
async function calibrateNative(page, { raise = true } = {}) {
  let lastDiag = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (raise) raiseElectronWindow();
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(attempt === 1 ? 800 : 1200);

    const gaps = await sampleRafGaps(page, 1200);
    // Discard first gap; drop occluded/1Hz samples (≥200ms) so they don't
    // poison p50. Keep ordinary jank (<200ms) — p50 still tracks native.
    const usable = gaps.slice(1).filter((g) => g > 0 && g < 200);
    const sorted = [...usable].sort((a, b) => a - b);
    const nativeIntervalMs = Math.round(pct(sorted, 50) * 100) / 100;
    const rawP50 = Math.round(pct([...gaps].sort((a, b) => a - b), 50) * 10) / 10;
    lastDiag =
      `attempt=${attempt} gaps=${gaps.length} usable=${usable.length} ` +
      `rawP50=${rawP50}ms usableP50=${nativeIntervalMs}ms ` +
      `sample=[${gaps
        .slice(0, 6)
        .map((g) => Math.round(g))
        .join(",")}…]`;

    if (nativeIntervalMs > 0 && usable.length >= 10) {
      const refreshHz = Math.round((1000 / nativeIntervalMs) * 10) / 10;
      // Drop = gap beyond ~1.5× native (matches the temp probe that found the root cause).
      const dropThresholdMs = nativeIntervalMs * 1.5 + 1;
      // Occlusion / Chromium background throttle ≈ 1Hz → gaps near 1000ms.
      const throttleGapMs = Math.max(200, nativeIntervalMs * 8);
      const throttleMaxFps = Math.max(5, Math.floor(refreshHz * 0.2));
      return {
        nativeIntervalMs,
        refreshHz,
        dropThresholdMs,
        throttleGapMs,
        throttleMaxFps,
        calibrateGapsN: usable.length,
        calibrateP95: Math.round(pct(sorted, 95) * 10) / 10,
        calibrateAttempts: attempt,
      };
    }
    console.warn(`[live-perf] calibrate retry — ${lastDiag}`);
  }
  throw new Error(
    `native refresh calibration failed (${lastDiag}). ` +
      "Keep the AgentCore window fully visible (not covered by the IDE) and retry.",
  );
}

/** @param {{ n: number, p50: number, hiddenFrames: number }} s @param {Awaited<ReturnType<typeof calibrateNative>>} cal */
function isThrottledSecond(s, cal, hiddenFrames) {
  if (hiddenFrames > 0) return true;
  if (s.n <= cal.throttleMaxFps) return true;
  if (s.p50 >= cal.throttleGapMs) return true;
  return false;
}

function printHelp() {
  console.log(`Live CDP graph jank probe (real running Electron app).

Start the app with CDP:
  pnpm -C apps/desktop exec electron-vite dev --remoteDebuggingPort=9222

Then:
  pnpm -C apps/desktop shoot:graph-perf-live
  pnpm -C apps/desktop shoot:graph-perf-live -- 180
  pnpm -C apps/desktop shoot:graph-perf-live -- --port 9222 --cid <uuid>

See script header for all flags. Output → shoot-out-graph-perf/live-*.json`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  process.chdir(desktopDir);
  await mkdir(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = resolve(outDir, opts.out ?? `live-${stamp}.json`);

  console.log(`[live-perf] connecting CDP ${opts.cdp}`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(opts.cdp);
  } catch (err) {
    console.error(
      `[live-perf] CDP connect failed (${opts.cdp}).\n` +
        "Start the app with:\n" +
        "  pnpm -C apps/desktop exec electron-vite dev --remoteDebuggingPort=9222\n" +
        `Detail: ${err?.message ?? err}`,
    );
    process.exit(1);
  }

  const pages = browser.contexts().flatMap((c) => c.pages());
  const page =
    pages.find((p) => /5173|localhost|127\.0\.0\.1/.test(p.url())) || pages[0];
  if (!page) {
    await browser.close();
    throw new Error("no renderer page attached via CDP");
  }
  console.log(`[live-perf] attached ${page.url()}`);

  console.log(
    "[live-perf] calibrating native refresh — keep the AgentCore window visible",
  );
  const cal = await calibrateNative(page, { raise: opts.raise });
  console.log(
    `[live-perf] native ${cal.refreshHz}Hz (interval ${cal.nativeIntervalMs}ms); ` +
      `drop if gap > ${cal.dropThresholdMs.toFixed(1)}ms; ` +
      `throttle exclude if fps≤${cal.throttleMaxFps} or p50≥${cal.throttleGapMs}ms`,
  );

  console.log("[live-perf] installing recorder:", await page.evaluate(RECORDER));
  if (opts.cids.length) {
    console.log(
      `[live-perf] will walk ${opts.cids.length} conversation(s) during recording`,
    );
  }
  console.log(
    `\nRecording ${opts.durationSec}s. Reproduce the jank now` +
      (opts.cids.length ? " (auto-navigating --cid)" : "") +
      ".\n" +
      "sec  fps  p50    p95    max     drop  LT(max)  rf/nodes/edges  anim smil pulse spin  heapMB  route\n" +
      "-".repeat(118),
  );

  const all = [];
  const started = Date.now();
  let lastPerf = null;
  let cidIndex = 0;
  let nextCidAt = opts.cids.length ? started + 1500 : Number.POSITIVE_INFINITY;

  while ((Date.now() - started) / 1000 < opts.durationSec) {
    if (opts.cids.length && Date.now() >= nextCidAt && cidIndex < opts.cids.length) {
      const cid = opts.cids[cidIndex++];
      console.log(`[live-perf] navigate #/conversations/${cid.slice(0, 8)}…`);
      await page
        .evaluate((id) => {
          location.hash = `#/conversations/${id}`;
        }, cid)
        .catch(() => {});
      nextCidAt = Date.now() + opts.settleMs;
    }

    await page.waitForTimeout(1000);
    let drained;
    try {
      drained = await page.evaluate(DRAIN);
    } catch {
      console.log("(context lost — reinstalling recorder)");
      if (opts.raise) raiseElectronWindow();
      await page.bringToFront().catch(() => {});
      await page.evaluate(RECORDER).catch(() => {});
      continue;
    }
    if (!drained) {
      await page.evaluate(RECORDER).catch(() => {});
      continue;
    }
    lastPerf = drained.perf ?? lastPerf;
    for (const b of drained.buckets) {
      const s = stats(b.gaps, cal.dropThresholdMs);
      const throttled = isThrottledSecond(s, cal, b.hiddenFrames);
      const sec = Math.round((b.t - started) / 1000);
      const row = {
        sec,
        ...s,
        longTasks: b.longTasks,
        longTaskMaxMs: b.longTaskMaxMs,
        hiddenFrames: b.hiddenFrames,
        throttled,
        gaps: b.gaps,
        inv: drained.inv,
      };
      all.push(row);
      const flag = throttled
        ? " THROTTLED"
        : s.max > cal.dropThresholdMs * 3
          ? " <<< JANK"
          : s.dropped > 5
            ? " <<"
            : "";
      console.log(
        `${String(sec).padStart(3)}  ${String(s.n).padStart(3)}  ${String(s.p50).padStart(5)}  ${String(
          s.p95,
        ).padStart(5)}  ${String(s.max).padStart(6)}  ${String(s.dropped).padStart(4)}  ${String(
          b.longTasks,
        ).padStart(2)}(${String(b.longTaskMaxMs).padStart(4)})  ${String(
          drained.inv.reactFlows,
        ).padStart(2)}/${String(drained.inv.graphNodes).padStart(3)}/${String(
          drained.inv.graphEdges,
        ).padStart(3)}       ${String(drained.inv.anims).padStart(3)} ${String(
          drained.inv.smil,
        ).padStart(4)} ${String(drained.inv.pulse).padStart(5)} ${String(
          drained.inv.spin,
        ).padStart(4)}  ${String(drained.inv.heapMB).padStart(6)}  ${String(
          drained.inv.hash,
        ).slice(0, 28)}${flag}`,
      );
    }
  }

  const usable = all.filter((r) => !r.throttled);
  const worst = [...usable].sort((a, b) => b.max - a.max).slice(0, 15);
  const report = {
    kind: "graph-perf-live",
    cdp: opts.cdp,
    durationSec: opts.durationSec,
    cids: opts.cids,
    display: {
      refreshHz: cal.refreshHz,
      nativeIntervalMs: cal.nativeIntervalMs,
      dropThresholdMs: Math.round(cal.dropThresholdMs * 10) / 10,
      throttleGapMs: cal.throttleGapMs,
      throttleMaxFps: cal.throttleMaxFps,
      calibrateGapsN: cal.calibrateGapsN,
      calibrateP95: cal.calibrateP95,
      calibrateAttempts: cal.calibrateAttempts,
    },
    secondsRecorded: all.length,
    secondsThrottledExcluded: all.length - usable.length,
    aggregate: stats(
      usable.flatMap((r) => r.gaps),
      cal.dropThresholdMs,
    ),
    worstSeconds: worst.map((r) => ({
      sec: r.sec,
      fps: r.n,
      p50: r.p50,
      p95: r.p95,
      p99: r.p99,
      max: r.max,
      dropped: r.dropped,
      longTasks: r.longTasks,
      longTaskMaxMs: r.longTaskMaxMs,
      inv: r.inv,
    })),
    graphPerf: lastPerf,
    series: all.map(({ gaps, ...rest }) => rest),
  };
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("\n=== DISPLAY ===");
  console.log(
    `${report.display.refreshHz}Hz native (${report.display.nativeIntervalMs}ms); ` +
      `drop > ${report.display.dropThresholdMs}ms`,
  );
  console.log("\n=== AGGREGATE (non-throttled seconds only) ===");
  console.log(JSON.stringify(report.aggregate, null, 2));
  console.log(
    `throttled/occluded seconds excluded: ${report.secondsThrottledExcluded}`,
  );
  console.log("\n=== WORST SECONDS ===");
  for (const w of report.worstSeconds) {
    console.log(
      `sec ${String(w.sec).padStart(3)}  fps=${String(w.fps).padStart(3)} max=${String(
        w.max,
      ).padStart(7)}ms dropped=${String(w.dropped).padStart(3)} longtask=${w.longTasks}(${
        w.longTaskMaxMs
      }ms) nodes=${w.inv.graphNodes} anim=${w.inv.anims} pulse=${w.inv.pulse} spin=${
        w.inv.spin
      } heap=${w.inv.heapMB}MB ${String(w.inv.hash).slice(0, 30)}`,
    );
  }
  console.log("\n=== __graphPerf ===");
  console.log(JSON.stringify(report.graphPerf, null, 2));
  console.log("\nwrote", outFile);

  // Disconnect CDP client only — do not close the user's running app.
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
