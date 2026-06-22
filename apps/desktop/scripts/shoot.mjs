// Screenshot harness for the offline AI preview (#/preview).
//
// Boots the renderer as a plain browser app (vite.web.config.ts → main.web.tsx,
// which stubs the four Electron globals), then drives a headless Chromium to each
// committed conformance scenario and writes a PNG per scenario. This is the tight
// loop the AI uses to self-check UI changes: edit a component → `pnpm shoot` →
// read the PNGs in out/preview/ — no Electron, no backend, no LLM, no tokens.
//
// It also doubles as a CI render smoke gate: a scenario that crashes on render
// (uncaught error, or the page never mounts #/preview) is a failure and the
// process exits non-zero, so a component change can't silently break an AI state.
//
// Usage:
//   node scripts/shoot.mjs                 # shoot every scenario
//   node scripts/shoot.mjs debate          # only scenarios whose name includes "debate"
//   SHOOT_SETTLE_MS=1200 node scripts/shoot.mjs   # longer settle for async graphs
//
// Env knobs: SHOOT_SETTLE_MS (default 800), SHOOT_WIDTH (1440), SHOOT_HEIGHT (900),
// SHOOT_SCALE (2), SHOOT_THEME ("light" | "dark", default light).

import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const fixturesDir = resolve(repoRoot, "packages/protocol-conformance/fixtures");
const outDir = resolve(desktopDir, "out/preview");

const SETTLE_MS = Number(process.env.SHOOT_SETTLE_MS ?? 800);
const VIEWPORT = {
  width: Number(process.env.SHOOT_WIDTH ?? 1440),
  height: Number(process.env.SHOOT_HEIGHT ?? 900),
};
const SCALE = Number(process.env.SHOOT_SCALE ?? 2);
const THEME = process.env.SHOOT_THEME === "dark" ? "dark" : "light";
const filter = (process.argv[2] ?? "").toLowerCase();

async function loadScenarios() {
  const files = (await readdir(fixturesDir))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const scenarios = [];
  for (const file of files) {
    const { name, description } = JSON.parse(
      await readFile(resolve(fixturesDir, file), "utf8"),
    );
    if (name) scenarios.push({ name, description: description ?? "" });
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
  // Collect uncaught renderer errors per scenario. An error means the AI state
  // failed to render even if the tree didn't fully unmount, so the smoke gate
  // counts it as a failure.
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  let ok = 0;
  const failures = [];
  for (const [i, s] of scenarios.entries()) {
    const label = `[${i + 1}/${scenarios.length}] ${s.name}`;
    pageErrors.length = 0;
    let failure = null;
    try {
      // A distinct search param forces a full reload per scenario (hash-only
      // changes don't reload), so every shot starts from a clean app boot.
      const url = new URL("index.web.html", base);
      url.searchParams.set("shoot", String(i));
      url.hash = `/preview?s=${encodeURIComponent(s.name)}`;
      await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
      await page.waitForSelector(`[data-preview-scenario="${s.name}"]`, {
        timeout: 15_000,
      });
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      // Let async renderers (elk team-graph layout, mermaid, katex) settle.
      await page.waitForTimeout(SETTLE_MS);
    } catch (err) {
      failure = String(err?.message ?? err);
    }
    // Always shoot — even on failure — so a red CI gate has visual evidence (e.g.
    // the RouteError fallback) to upload as an artifact.
    await page
      .screenshot({ path: resolve(outDir, `${s.name}.png`) })
      .catch(() => {});
    if (pageErrors.length) {
      failure = `${failure ? `${failure}; ` : ""}page error: ${pageErrors.join(" | ")}`;
    }
    if (failure) {
      failures.push({ name: s.name, error: failure });
      console.error(`  \u2717 ${label} — ${failure}`);
    } else {
      ok += 1;
      console.log(`  \u2713 ${label}`);
    }
  }

  await browser.close();
  await server.close();

  console.log(`\nDone: ${ok}/${scenarios.length} → ${outDir}`);
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
