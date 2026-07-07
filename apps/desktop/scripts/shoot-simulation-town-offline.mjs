/**
 * Offline render smoke for AI town 3D (#/simulation/town?preview=1).
 * Boots vite.web (no backend), seeds mock tick state, screenshots canvas.
 *
 * Usage: node scripts/shoot-simulation-town-offline.mjs
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const outDir = resolve(desktopDir, "shoot-out");

const SETTLE_MS = Number(process.env.SHOOT_SETTLE_MS ?? 5000);
const VIEWPORT = {
  width: Number(process.env.SHOOT_WIDTH ?? 1440),
  height: Number(process.env.SHOOT_HEIGHT ?? 900),
};
const SCALE = Number(process.env.SHOOT_SCALE ?? 2);

async function main() {
  await mkdir(outDir, { recursive: true });

  process.chdir(desktopDir);

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
  const url = new URL("index.web.html", base);
  url.hash = "/simulation/town?preview=1";

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
  });

  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(url.href, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector('[data-town-canvas="ready"] canvas', {
    timeout: 60_000,
  });
  await page.waitForTimeout(SETTLE_MS);

  const shot = resolve(outDir, "simulation-town-preview.png");
  await page.screenshot({ path: shot });

  await browser.close();
  await server.close();

  if (pageErrors.length) {
    console.error("Page errors:", pageErrors.join(" | "));
    process.exitCode = 1;
  }
  console.log(`Wrote ${shot}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
