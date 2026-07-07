/**
 * One-off 3D town perf sampler — run while `pnpm dev` is up:
 *   node scripts/spike-town3d-perf.mjs
 */
import { chromium } from "playwright";

const URL = "http://localhost:5173/#/simulation/town";
const WARMUP_MS = 4000;
const SAMPLE_MS = 6000;

async function samplePerf(page, label) {
  await page.waitForTimeout(WARMUP_MS);
  const samples = [];
  const end = Date.now() + SAMPLE_MS;
  while (Date.now() < end) {
    const perf = await page.evaluate(() => window.__SPIKE_PERF__);
    if (perf?.fps) samples.push(perf);
    await page.waitForTimeout(200);
  }
  if (samples.length === 0) {
    throw new Error(`No perf samples for ${label}`);
  }
  const fpsVals = samples.map((s) => s.fps);
  const heapVals = samples.map((s) => s.heapMb).filter((h) => h != null);
  const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  const min = (arr) => Math.min(...arr);
  return {
    label,
    fpsAvg: avg(fpsVals),
    fpsMin: min(fpsVals),
    heapMbAvg: heapVals.length ? avg(heapVals) : null,
    samples: samples.length,
  };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(URL, { waitUntil: "networkidle", timeout: 60_000 });

await page.waitForSelector("canvas", { timeout: 30_000 });
await page.waitForFunction(
  () => {
    const canvas = document.querySelector("canvas");
    return canvas && canvas.width > 0;
  },
  { timeout: 30_000 },
);

const withStress = await samplePerf(page, "stress-on");
await page.getByRole("button", { name: /Stress:/ }).click();
const withoutStress = await samplePerf(page, "stress-off");

await browser.close();

console.log(JSON.stringify({ withStress, withoutStress }, null, 2));
