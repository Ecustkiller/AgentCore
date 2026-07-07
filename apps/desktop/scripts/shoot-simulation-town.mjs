/**
 * Screenshot harness for the AI town 3D scene (#/simulation/town).
 *
 * Requires `pnpm dev` (5173) and backend with SIMULATION_ENABLED.
 *
 * Usage:
 *   node scripts/shoot-simulation-town.mjs
 *   SHOOT_SETTLE_MS=5000 node scripts/shoot-simulation-town.mjs
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const outDir = resolve(desktopDir, "shoot-out");

const URL = process.env.SHOOT_TOWN_URL ?? "http://localhost:5173/#/simulation/town";
const SETTLE_MS = Number(process.env.SHOOT_SETTLE_MS ?? 4500);
const VIEWPORT = {
  width: Number(process.env.SHOOT_WIDTH ?? 1440),
  height: Number(process.env.SHOOT_HEIGHT ?? 900),
};
const SCALE = Number(process.env.SHOOT_SCALE ?? 2);

async function main() {
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
  });

  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("canvas", { timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      return canvas && canvas.width > 0;
    },
    { timeout: 30_000 },
  );
  await page.waitForTimeout(SETTLE_MS);

  const overview = resolve(outDir, "simulation-town.png");
  await page.screenshot({ path: overview });

  // Zoomed framing via orbit — drag to tilt slightly for detail check
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (box) {
    const cx = box.x + box.width * 0.35;
    const cy = box.y + box.height * 0.45;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy - 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(800);
  }
  const zoom = resolve(outDir, "simulation-town-zoom.png");
  await page.screenshot({ path: zoom });

  await browser.close();

  if (pageErrors.length) {
    console.error("Page errors:", pageErrors.join(" | "));
    process.exitCode = 1;
  }
  console.log(`Wrote ${overview}`);
  console.log(`Wrote ${zoom}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
