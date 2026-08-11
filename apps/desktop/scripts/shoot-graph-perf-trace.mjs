// Live CDP Chrome-trace attribution probe: break down >=Nms main-thread tasks
// into Layout / Recalculate Style / Paint / JS / GC, and name the JS frames.
//
// Complements the other graph-perf probes:
//   shoot:graph-perf       offline #/preview (≤9 nodes, never hits ELK)
//   shoot:graph-perf-live  real app FPS / longtask counts (not "what ran")
//   shoot:graph-perf-trace THIS — answers "what ran inside those long tasks"
//
// A V8 CPU profile alone cannot do this: everything non-JS collapses into
// "(program)". This script uses Chrome Tracing so Layout / Style / Paint / GC
// stay visible and JS is attributed to concrete function names.
//
// Does NOT depend on __graphPerf (dev-only); works against production builds.
//
// Prerequisite — start the desktop app with CDP enabled:
//   pnpm -C apps/desktop exec electron-vite dev --remoteDebuggingPort=9222
//   (or a production build launched with the same remoteDebuggingPort)
//
// Usage:
//   pnpm -C apps/desktop shoot:graph-perf-trace
//   pnpm -C apps/desktop shoot:graph-perf-trace -- 60
//   pnpm -C apps/desktop shoot:graph-perf-trace -- --port 9222 --duration 90
//   pnpm -C apps/desktop shoot:graph-perf-trace -- --cid <uuid> [--cid <uuid>...]
//
// Args / flags:
//   [durationSec]     record length (default 60); positional or --duration
//   --cdp <url>       CDP endpoint (default http://127.0.0.1:9222)
//   --port <n>        shorthand → http://127.0.0.1:<n>
//   --out <file>      JSON path (default shoot-out-graph-perf/trace-<stamp>.json)
//   --long <ms>       long-task threshold (default 50)
//   --cid <id>        auto-switch conversation(s) during recording (repeatable)
//   --switch-ms <n>   interval between --cid hash changes (default 8000)
//
// Phase marks (performance.mark → blink.user_timing) split idle vs switching
// so "janky even when I don't touch it" can be proven or falsified.
//
// Writes JSON under shoot-out-graph-perf/.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const outDir = resolve(desktopDir, "shoot-out-graph-perf");

function parseArgs(argv) {
  const opts = {
    durationSec: 60,
    cdp: "http://127.0.0.1:9222",
    out: null,
    longMs: 50,
    cids: [],
    switchMs: 8000,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cdp") opts.cdp = argv[++i];
    else if (a === "--port") opts.cdp = `http://127.0.0.1:${argv[++i]}`;
    else if (a === "--duration") opts.durationSec = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--long") opts.longMs = Number(argv[++i]);
    else if (a === "--cid") opts.cids.push(argv[++i]);
    else if (a === "--switch-ms") opts.switchMs = Number(argv[++i]);
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
  if (!Number.isFinite(opts.longMs) || opts.longMs <= 0) {
    throw new Error(`invalid --long: ${opts.longMs}`);
  }
  if (!Number.isFinite(opts.switchMs) || opts.switchMs <= 0) {
    throw new Error(`invalid --switch-ms: ${opts.switchMs}`);
  }
  return opts;
}

function printHelp() {
  console.log(`Live CDP Chrome-trace attribution probe (real running Electron app).

Breaks main-thread long tasks into Layout / Style / Paint / GC / JS and names
the JS frames — what shoot:graph-perf-live cannot answer.

Start the app with CDP:
  pnpm -C apps/desktop exec electron-vite dev --remoteDebuggingPort=9222

Then:
  pnpm -C apps/desktop shoot:graph-perf-trace
  pnpm -C apps/desktop shoot:graph-perf-trace -- 90
  pnpm -C apps/desktop shoot:graph-perf-trace -- --port 9222 --cid <uuid>

See script header for all flags. Output → shoot-out-graph-perf/trace-*.json`);
}

const dur = (e) => e.dur ?? 0;

// Merge Profile / ProfileChunk trace events back into a sample timeline per
// thread, so samples can be intersected with the long-task windows below.
function buildProfiles(chunks) {
  const perThread = new Map();
  const get = (k) =>
    perThread.get(k) ??
    (perThread.set(k, { nodes: new Map(), ts: [], node: [] }), perThread.get(k));
  const startTs = new Map();

  for (const e of chunks) {
    if (e.name !== "Profile" && e.name !== "ProfileChunk") continue;
    const k = `${e.pid}:${e.tid}`;
    const d = e.args?.data;
    if (e.name === "Profile") {
      startTs.set(k, d?.startTime ?? e.ts);
      get(k);
      continue;
    }
    const p = get(k);
    const cp = d?.cpuProfile ?? {};
    for (const n of cp.nodes ?? []) p.nodes.set(n.id, n);
    const samples = cp.samples ?? [];
    const deltas = d?.timeDeltas ?? [];
    let t = startTs.get(k) ?? e.ts;
    if (p.ts.length) t = p.ts[p.ts.length - 1];
    for (let i = 0; i < samples.length; i++) {
      t += deltas[i] ?? 0;
      p.ts.push(t);
      p.node.push(samples[i]);
    }
    startTs.set(k, t);
  }
  return perThread;
}

function frameLabel(profile, nodeId) {
  const n = profile.nodes.get(nodeId);
  if (!n) return null;
  const f = n.callFrame ?? {};
  const name = f.functionName || "(anonymous)";
  if (name === "(idle)" || name === "(program)" || name === "(root)") return null;
  const file = (f.url || "").split("/").slice(-1)[0] || "native";
  return `${name} @ ${file}:${f.lineNumber ?? "?"}`;
}

function analyzeThread(key, {
  completeEvents,
  phaseMarks,
  profileByPid,
  longMs,
  durationSec,
}) {
  const evs = completeEvents
    .filter((e) => `${e.pid}:${e.tid}` === key)
    .sort((a, b) => a.ts - b.ts || dur(b) - dur(a));

  // Parent/child via containment stack → self time per event.
  const stack = [];
  for (const e of evs) {
    while (stack.length && stack[stack.length - 1]._end <= e.ts) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent._childUs = (parent._childUs ?? 0) + dur(e);
    e._end = e.ts + dur(e);
    stack.push(e);
  }
  for (const e of evs) e._self = Math.max(0, dur(e) - (e._childUs ?? 0));

  const tasks = evs.filter((e) => e.name === "RunTask").sort((a, b) => dur(b) - dur(a));

  // Attaching the sampling profiler shows up as a fat task that is almost all
  // V8.InvokeApiInterruptCallbacks. That is the probe, not the app — drop it
  // via structured recognition, not a wall-clock skip window.
  const longTasks = [];
  let artifactMs = 0;
  for (const t of tasks) {
    if (dur(t) < longMs * 1000) continue;
    const contained = [];
    let interruptUs = 0;
    for (const e of evs) {
      if (e.ts < t.ts || e._end > t._end || e === t) continue;
      contained.push(e);
      if (e.name === "V8.InvokeApiInterruptCallbacks") interruptUs += e._self;
    }
    if (interruptUs > 0.4 * dur(t)) {
      artifactMs += dur(t) / 1000;
      t._artifact = true;
      continue;
    }
    t._contained = contained;
    longTasks.push(t);
  }

  // Busy share per phase — the answer to "it stutters even when I don't touch it".
  // Avoid Math.max(...array) / Math.min(...array) — event counts can be huge.
  let traceEnd = 0;
  if (evs.length) {
    traceEnd = evs[0].ts;
    for (const e of evs) {
      if (e._end > traceEnd) traceEnd = e._end;
    }
  }
  const spans = phaseMarks.map((m, i) => ({
    name: m.name,
    from: m.ts,
    to: phaseMarks[i + 1]?.ts ?? traceEnd,
  }));
  const byPhase = new Map();
  for (const t of tasks) {
    const s = spans.find((x) => t.ts >= x.from && t.ts < x.to);
    if (!s) continue;
    const rec = byPhase.get(s.name) ?? {
      busyUs: 0,
      n: 0,
      longN: 0,
      longUs: 0,
      maxUs: 0,
      spanUs: s.to - s.from,
    };
    rec.busyUs += dur(t);
    rec.n += 1;
    if (!t._artifact) rec.maxUs = Math.max(rec.maxUs, dur(t));
    if (!t._artifact && dur(t) >= longMs * 1000) {
      rec.longN += 1;
      rec.longUs += dur(t);
    }
    byPhase.set(s.name, rec);
  }

  const selfByName = new Map();
  const jsFrames = new Map();
  let longTotalUs = 0;
  for (const t of longTasks) {
    longTotalUs += dur(t);
    for (const e of t._contained) {
      selfByName.set(e.name, (selfByName.get(e.name) ?? 0) + e._self);
    }
    selfByName.set("RunTask(self)", (selfByName.get("RunTask(self)") ?? 0) + t._self);

    // Chunks land on a profiler-owned tid, not the profiled thread's tid —
    // associate by process (densest sample stream for that pid, set up above).
    const prof = profileByPid.get(Number(key.split(":")[0]));
    if (!prof) continue;
    for (let i = 1; i < prof.ts.length; i++) {
      const ts = prof.ts[i];
      if (ts < t.ts) continue;
      if (ts > t._end) break;
      const label = frameLabel(prof, prof.node[i]);
      if (label) jsFrames.set(label, (jsFrames.get(label) ?? 0) + (ts - prof.ts[i - 1]));
    }
  }

  // What are all those tasks made of? Long-task attribution misses a storm of
  // thousands of tiny tasks, which is its own kind of jank.
  const phaseHist = new Map();
  for (const e of evs) {
    const s = spans.find((x) => e.ts >= x.from && e.ts < x.to);
    if (!s) continue;
    const h = phaseHist.get(s.name) ?? new Map();
    const rec = h.get(e.name) ?? { n: 0, selfUs: 0 };
    rec.n += 1;
    rec.selfUs += e._self;
    h.set(e.name, rec);
    phaseHist.set(s.name, h);
  }

  const rank = (m, n) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => [k, us]);

  let busyUs = 0;
  for (const t of tasks) busyUs += dur(t);

  return {
    key,
    busyMs: Math.round(busyUs / 1000),
    taskCount: tasks.length,
    artifactMs: Math.round(artifactMs),
    byPhase: [...byPhase.entries()].map(([name, r]) => ({
      name,
      spanSec: +(r.spanUs / 1e6).toFixed(1),
      busyPct: r.spanUs > 0 ? +((100 * r.busyUs) / r.spanUs).toFixed(1) : 0,
      tasks: r.n,
      maxMs: Math.round(r.maxUs / 1000),
      longN: r.longN,
      longMs: Math.round(r.longUs / 1000),
      topEvents: [...(phaseHist.get(name) ?? new Map()).entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 8)
        .map(([n2, v]) => ({ name: n2, n: v.n, ms: +(v.selfUs / 1000).toFixed(0) })),
    })),
    topTaskMs: tasks.slice(0, 10).map((t) => Math.round(dur(t) / 1000)),
    longTasks,
    longTotalUs,
    selfByName: rank(selfByName, 22),
    jsFrames: rank(jsFrames, 12),
    durationSec,
  };
}

function printThreadReport(a, longMs) {
  console.log(
    `\n=== renderer ${a.key} — main thread busy ${a.busyMs}ms in ${a.durationSec}s, ${a.taskCount} tasks`,
  );
  console.log(`    longest tasks: ${a.topTaskMs.map((m) => m + "ms").join(", ")}`);
  for (const p of a.byPhase) {
    console.log(
      `      phase ${p.name.padEnd(12)} ${String(p.spanSec).padStart(5)}s  busy ${String(p.busyPct).padStart(5)}%  tasks=${String(p.tasks).padStart(6)}  max=${String(p.maxMs).padStart(4)}ms  long=${p.longN} (${p.longMs}ms)`,
    );
    if (p.tasks > 200) {
      console.log(
        `        events: ${p.topEvents.map((e) => `${e.name}×${e.n}(${e.ms}ms)`).join("  ")}`,
      );
    }
  }
  console.log(
    `    tasks >= ${longMs}ms: n=${a.longTasks.length} total=${Math.round(a.longTotalUs / 1000)}ms` +
      (a.artifactMs ? ` (excluded ${a.artifactMs}ms of profiler-attach artifact)` : ""),
  );
  if (!a.longTasks.length) return;
  console.log("    --- self time inside long tasks ---");
  for (const [name, us] of a.selfByName) {
    console.log(
      `      ${String((us / 1000).toFixed(1)).padStart(9)}ms  ${((100 * us) / a.longTotalUs).toFixed(1).padStart(5)}%  ${name}`,
    );
  }
  if (a.jsFrames.length) {
    console.log("    --- JS frames inside long tasks (self) ---");
    for (const [k, us] of a.jsFrames) {
      console.log(`      ${String((us / 1000).toFixed(1)).padStart(9)}ms  ${k}`);
    }
  }
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
  const outFile = resolve(outDir, opts.out ?? `trace-${stamp}.json`);

  console.log(`[trace] connecting CDP ${opts.cdp}`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(opts.cdp);
  } catch (err) {
    console.error(
      `[trace] CDP connect failed (${opts.cdp}).\n` +
        "Start the app with:\n" +
        "  pnpm -C apps/desktop exec electron-vite dev --remoteDebuggingPort=9222\n" +
        `Detail: ${err?.message ?? err}`,
    );
    process.exit(1);
  }

  const pages = browser.contexts().flatMap((c) => c.pages());
  console.log(`[trace] ${pages.length} page target(s)`);
  for (const p of pages) console.log("   -", p.url().slice(0, 110));
  if (!pages.length) {
    await browser.close();
    console.error("[trace] no renderer page attached via CDP");
    process.exit(1);
  }

  const cdp = await browser.newBrowserCDPSession();
  const chunks = [];
  cdp.on("Tracing.dataCollected", (e) => {
    // Avoid chunks.push(...e.value) — CDP batches can be large enough to blow the stack.
    if (e.value) for (const ev of e.value) chunks.push(ev);
  });
  const complete = new Promise((res) => cdp.once("Tracing.tracingComplete", res));

  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "blink.user_timing",
        // Needed to put NAMES on the JS inside long tasks; plain devtools.timeline
        // FunctionCall events ship without functionName.
        "disabled-by-default-v8.cpu_profiler",
      ],
    },
  });

  // performance.mark lands in the trace (blink.user_timing) on the trace clock,
  // which is how long tasks get bucketed into idle vs switching below.
  const driver =
    pages.find((p) => /5173|localhost|127\.0\.0\.1/.test(p.url())) ?? pages[0];
  const mark = async (name) => {
    try {
      await driver.evaluate((n) => performance.mark(n), `PHASE:${name}`);
    } catch {
      /* page may navigate mid-mark */
    }
  };
  const goto = async (cid) => {
    try {
      await driver.evaluate((id) => {
        location.hash = `#/conversations/${id}`;
      }, cid);
    } catch {
      /* ignore */
    }
  };

  // idle → switch → idle: "janky even when I don't touch it" is the first phase.
  const { durationSec, cids, switchMs, longMs } = opts;
  const idleSec = cids.length ? Math.min(60, Math.round(durationSec * 0.25)) : durationSec;
  const switchEndSec = durationSec - idleSec;

  console.log(
    cids.length
      ? `[trace] recording ${durationSec}s: idle 0-${idleSec}s, switching ${cids.length} conversations every ${switchMs}ms until ${switchEndSec}s, idle to end`
      : `[trace] recording ${durationSec}s — reproduce the jank now`,
  );

  const t0 = Date.now();
  let phase = "";
  let nextSwitch = idleSec * 1000;
  let cidIdx = 0;
  while (Date.now() - t0 < durationSec * 1000) {
    await new Promise((r) => setTimeout(r, 500));
    const elMs = Date.now() - t0;
    const el = Math.round(elMs / 1000);
    const want =
      !cids.length || elMs < idleSec * 1000
        ? "idle-before"
        : elMs < switchEndSec * 1000
          ? "switching"
          : "idle-after";
    if (want !== phase) {
      phase = want;
      await mark(phase);
      console.log(`\n  [${el}s] phase ${phase}`);
    }
    if (cids.length && phase === "switching" && elMs >= nextSwitch) {
      const cid = cids[cidIdx++ % cids.length];
      await goto(cid);
      nextSwitch = elMs + switchMs;
      process.stdout.write(` →${cid.slice(0, 8)}`);
    }
    if (el % 10 === 0) process.stdout.write(`  ${el}s`);
  }
  console.log("");

  await cdp.send("Tracing.end");
  await complete;
  console.log(`[trace] ${chunks.length} events`);

  const completeEvents = chunks.filter((e) => e.ph === "X" && typeof e.ts === "number");

  // Thread/process names come from metadata events, not the slices themselves.
  const threadName = new Map();
  const processName = new Map();
  for (const e of chunks) {
    if (e.ph !== "M") continue;
    if (e.name === "thread_name") threadName.set(`${e.pid}:${e.tid}`, e.args?.name);
    if (e.name === "process_name") processName.set(e.pid, e.args?.name);
  }

  const byThread = new Map();
  for (const e of completeEvents) {
    if (e.name !== "RunTask") continue;
    const k = `${e.pid}:${e.tid}`;
    const s = byThread.get(k) ?? { us: 0, n: 0, maxUs: 0 };
    s.us += dur(e);
    s.n += 1;
    s.maxUs = Math.max(s.maxUs, dur(e));
    byThread.set(k, s);
  }
  const ranking = [...byThread.entries()].sort((a, b) => b[1].us - a[1].us);
  console.log("[trace] threads by RunTask time:");
  for (const [k, s] of ranking.slice(0, 6)) {
    console.log(
      `   ${k} ${processName.get(Number(k.split(":")[0])) ?? "?"} / ${threadName.get(k) ?? "?"} — total ${Math.round(s.us / 1000)}ms n=${s.n} max=${Math.round(s.maxUs / 1000)}ms`,
    );
  }
  // Every renderer main thread — one per window, which is the whole point here.
  const mainKeys = ranking
    .filter(([k]) => threadName.get(k) === "CrRendererMain")
    .map(([k]) => k);
  if (!mainKeys.length) {
    await browser.close();
    console.error("[trace] no CrRendererMain RunTask events captured");
    process.exit(1);
  }
  console.log(`[trace] analyzing ${mainKeys.length} renderer main thread(s)`);

  const profiles = buildProfiles(chunks);
  // Chunks land on a profiler-owned tid, not the profiled thread's tid — associate
  // by process and take that process's densest sample stream (its main thread).
  const profileByPid = new Map();
  for (const [k, p] of profiles) {
    if (!p.ts.length) continue;
    const pid = Number(k.split(":")[0]);
    const cur = profileByPid.get(pid);
    if (!cur || p.ts.length > cur.ts.length) profileByPid.set(pid, p);
  }
  console.log(
    `[trace] cpu samples: ${
      [...profiles.entries()]
        .map(([k, p]) => `${k}=${p.ts.length}/${p.nodes.size}n`)
        .join(" ") || "NONE"
    } (Profile=${chunks.filter((e) => e.name === "Profile").length} ProfileChunk=${chunks.filter((e) => e.name === "ProfileChunk").length})`,
  );

  const phaseMarks = chunks
    .filter((e) => typeof e.name === "string" && e.name.startsWith("PHASE:"))
    .map((e) => ({ ts: e.ts, name: e.name.slice(6) }))
    .sort((a, b) => a.ts - b.ts);

  const report = [];
  for (const key of mainKeys) {
    const a = analyzeThread(key, {
      completeEvents,
      phaseMarks,
      profileByPid,
      longMs,
      durationSec,
    });
    report.push(a);
    printThreadReport(a, longMs);
  }

  const payload = {
    kind: "graph-perf-trace",
    cdp: opts.cdp,
    durationSec,
    longMs,
    cids,
    switchMs,
    renderers: report.map((a) => ({
      thread: a.key,
      busyMs: a.busyMs,
      taskCount: a.taskCount,
      artifactMs: a.artifactMs,
      topTaskMs: a.topTaskMs,
      byPhase: a.byPhase,
      longTaskCount: a.longTasks.length,
      longTaskTotalMs: Math.round(a.longTotalUs / 1000),
      selfByName: a.selfByName.map(([name, us]) => ({ name, ms: +(us / 1000).toFixed(1) })),
      jsFrames: a.jsFrames.map(([fn, us]) => ({ fn, ms: +(us / 1000).toFixed(1) })),
    })),
  };
  await writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${outFile}`);

  // Disconnect CDP client only — do not close the user's running app.
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
