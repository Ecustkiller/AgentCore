// Screenshot harness for the offline AI preview (#/preview).
//
// Boots the renderer as a plain browser app (vite.web.config.ts → main.web.tsx,
// which stubs the four Electron globals), then drives a headless Chromium to each
// committed conformance scenario and writes a PNG per scenario. This is the tight
// loop the AI uses to self-check UI changes: edit a component → `pnpm shoot` →
// read the PNGs in shoot-out/ — no Electron, no backend, no LLM, no tokens.
//
// It also doubles as a CI render smoke gate: a scenario that crashes on render
// (uncaught error, or the page never mounts #/preview) is a failure and the
// process exits non-zero, so a component change can't silently break an AI state.
//
// Usage:
//   node scripts/shoot.mjs                 # terminal state of every scenario
//   node scripts/shoot.mjs debate          # only scenarios whose name includes "debate"
//   SHOOT_FRAMES=3 node scripts/shoot.mjs  # + 3 mid-stream frames per scenario
//   SHOOT_SETTLE_MS=1200 node scripts/shoot.mjs   # longer settle for async graphs
//
// Env knobs: SHOOT_FRAMES (default 0 = terminal only; N = N evenly-spaced in-progress
// frames per scenario via #/preview?s=…&k=<count>, file `<name>.f<k>.png`),
// SHOOT_SETTLE_MS (default 800), SHOOT_WIDTH (1440), SHOOT_HEIGHT (900),
// SHOOT_SCALE (2), SHOOT_THEME ("light" | "dark", default light),
// SHOOT_VIEW ("chat" default | "canvas" → appends &view=canvas to shoot the canvas
// layout + 指挥台 region instead of the chat surface; canvas async layout (elk) wants
// a longer SHOOT_SETTLE_MS, e.g. 1500).

import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const fixturesDir = resolve(repoRoot, "packages/protocol-conformance/fixtures");
// Dev-only screenshot output. MUST stay outside electron-vite `out/` — electron-builder
// packs `out/**` into the installer (see electron-builder.yml `files`).
const SHOOT_OUT_DIR = "shoot-out";
const outDir = resolve(desktopDir, SHOOT_OUT_DIR);

const SETTLE_MS = Number(process.env.SHOOT_SETTLE_MS ?? 800);
const VIEWPORT = {
  width: Number(process.env.SHOOT_WIDTH ?? 1440),
  height: Number(process.env.SHOOT_HEIGHT ?? 900),
};
const SCALE = Number(process.env.SHOOT_SCALE ?? 2);
const THEME = process.env.SHOOT_THEME === "dark" ? "dark" : "light";
const FRAMES = Math.max(0, Number(process.env.SHOOT_FRAMES ?? 0) | 0);
const VIEW = process.env.SHOOT_VIEW === "canvas" ? "canvas" : "chat";
const filter = (process.argv[2] ?? "").toLowerCase();

/** Up to `frames` evenly-spaced event counts in (0, total) for mid-stream frames. */
function evenCuts(total, frames) {
  const cuts = new Set();
  for (let i = 1; i <= frames; i++) {
    const k = Math.round((total * i) / (frames + 1));
    if (k > 0 && k < total) cuts.add(k);
  }
  return [...cuts].sort((a, b) => a - b);
}

async function loadScenarios() {
  const files = (await readdir(fixturesDir))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const scenarios = [];
  for (const file of files) {
    const { name, description, events } = JSON.parse(
      await readFile(resolve(fixturesDir, file), "utf8"),
    );
    if (name)
      scenarios.push({
        name,
        description: description ?? "",
        events: Array.isArray(events) ? events.length : 0,
      });
  }
  return scenarios;
}

async function main() {
  // Run from the desktop package so vite.web.config.ts resolves its relative root
  // (src/renderer) and workspace-root fs allowlist exactly as designed.
  process.chdir(desktopDir);

  let scenarios = await loadScenarios();
  if (filter) {
    scenarios = scenarios.filter((s) => s.name.toLowerCase().includes(filter));
  }
  if (scenarios.length === 0) {
    console.error(
      filter
        ? `No scenarios matched filter "${filter}".`
        : `No fixtures found in ${fixturesDir}.`,
    );
    process.exitCode = 1;
    return;
  }

  // Fresh output dir so shots from deleted/renamed scenarios never linger.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log("Booting web preview (vite.web.config.ts)…");
  const server = await createServer({
    configFile: resolve(desktopDir, "vite.web.config.ts"),
    logLevel: "warn",
  });
  await server.listen();
  const base = server.resolvedUrls?.local?.[0];
  if (!base) {
    await server.close();
    throw new Error("Vite did not report a local URL.");
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    await server.close();
    console.error(
      `Failed to launch Chromium. Install the Playwright browser once:\n  pnpm -C apps/desktop exec playwright install chromium\n${String(err?.message ?? err)}`,
    );
    process.exitCode = 1;
    return;
  }

  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: THEME,
  });
  // The app's theme is class-based via its store (lib/theme.ts → `.dark` on <html>),
  // seeded from localStorage `agentcore:theme`; `colorScheme` alone only drives the
  // `system` choice and did not flip the preview here. Seed the store key so
  // SHOOT_THEME deterministically selects light/dark on every navigation.
  await page.addInitScript((theme) => {
    try {
      localStorage.setItem("agentcore:theme", theme);
    } catch {
      /* localStorage unavailable — fall back to colorScheme */
    }
  }, THEME);
  // Collect uncaught renderer errors per shot. An error means the AI state failed
  // to render even if the tree didn't fully unmount, so the smoke gate counts it
  // as a failure.
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  // Flatten to a shot list: the terminal state of every scenario, plus sampled
  // mid-stream frames when SHOOT_FRAMES>0 so the streaming intermediate states
  // (tool running, run started-not-completed…) are gated too, not just the end.
  const shots = [];
  for (const s of scenarios) {
    shots.push({ name: s.name, k: null, file: `${s.name}.png` });
    if (FRAMES > 0) {
      for (const k of evenCuts(s.events, FRAMES)) {
        shots.push({ name: s.name, k, file: `${s.name}.f${k}.png` });
      }
    }
  }

  let ok = 0;
  const failures = [];
  for (const [i, shot] of shots.entries()) {
    const label = `[${i + 1}/${shots.length}] ${shot.file}`;
    pageErrors.length = 0;
    let failure = null;
    try {
      // A distinct search param forces a full reload per shot (hash-only changes
      // don't reload), so every shot starts from a clean app boot.
      const url = new URL("index.web.html", base);
      url.searchParams.set("shoot", String(i));
      const viewSuffix = VIEW === "canvas" ? "&view=canvas" : "";
      url.hash =
        shot.k === null
          ? `/preview?s=${encodeURIComponent(shot.name)}${viewSuffix}`
          : `/preview?s=${encodeURIComponent(shot.name)}&k=${shot.k}${viewSuffix}`;
      await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
      const frameSel = shot.k === null ? "full" : String(shot.k);
      await page.waitForSelector(
        `[data-preview-scenario="${shot.name}"][data-preview-frame="${frameSel}"]`,
        { timeout: 15_000 },
      );
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      // Let async renderers (elk team-graph layout, mermaid, katex) settle.
      await page.waitForTimeout(SETTLE_MS);
    } catch (err) {
      failure = String(err?.message ?? err);
    }
    // Always shoot — even on failure — so a red CI gate has visual evidence (e.g.
    // the RouteError fallback) to upload as an artifact.
    await page.screenshot({ path: resolve(outDir, shot.file) }).catch(() => {});
    if (pageErrors.length) {
      failure = `${failure ? `${failure}; ` : ""}page error: ${pageErrors.join(" | ")}`;
    }
    if (failure) {
      failures.push({ name: shot.file, error: failure });
      console.error(`  \u2717 ${label} — ${failure}`);
    } else {
      ok += 1;
      console.log(`  \u2713 ${label}`);
    }
  }

  await browser.close();
  await server.close();

  console.log(`\nDone: ${ok}/${shots.length} → ${outDir}`);
  if (failures.length) {
    console.error(`${failures.length} failed:`);
    for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
