/**
 * Targeted round stills: click scoreboard「第N轮」→ wait for round heading in view → shot.
 * Overwrites only 04/05/05b/06. Requires replay server. Port 5174 (CORS).
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const root = resolve(desktopDir, "../..");
const stillsDir = resolve(root, "apps/promo/assets/lv-molihua/stills");
const API = (process.env.PROMO_API ?? "http://localhost:8015").replace(/\/$/, "");
const PORT = Number(process.env.PROMO_PORT ?? 5174);
const SPEED = Number(process.env.PROMO_SPEED ?? 25);
const GAP = Number(process.env.PROMO_GAP ?? 300);
const TAPE = "lv-molihua-trademark";
process.env.VITE_API_URL = API;

const JOBS = [
  {
    id: "04-r2-diamond-square",
    round: 2,
    needles: ["菱形", "正方形"],
    anyOf: false,
  },
  {
    id: "05-r3-logo-swap",
    round: 3,
    needles: ["更换Logo", "换标", "诉讼期间"],
    anyOf: true,
  },
  {
    id: "05b-r4-logo-defense",
    round: 4,
    needles: ["小程序", "客服头像"],
    anyOf: false,
  },
  {
    id: "06-r5-burden",
    round: 5,
    needles: ["举证责任", "间接证据", "实际混淆"],
    anyOf: true,
  },
];

async function main() {
  process.chdir(desktopDir);
  await mkdir(stillsDir, { recursive: true });
  const server = await createServer({
    configFile: resolve(desktopDir, "vite.webapp.config.ts"),
    logLevel: "warn",
    server: { port: PORT, strictPort: true },
  });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    colorScheme: "light",
    locale: "zh-CN",
  });
  let csrf = null;
  page.on("response", (r) => {
    const t = r.headers()["x-csrf-token"];
    if (t) csrf = t;
  });
  const result = { ok: [], miss: [], fatal: null };

  try {
    await page.goto(new URL("index.webapp.html", base).href, { waitUntil: "load", timeout: 30000 });
    const userBox = page.getByPlaceholder("用户名");
    const composer = page.getByPlaceholder(/输入消息/);
    await Promise.race([
      userBox.waitFor({ state: "visible", timeout: 20000 }).catch(() => {}),
      composer.waitFor({ state: "visible", timeout: 20000 }).catch(() => {}),
    ]);
    if (await userBox.isVisible().catch(() => false)) {
      await userBox.fill("dev");
      await page.getByPlaceholder(/密码/).first().fill("devpassword");
      await page.locator('button[type="submit"]').click();
    }
    await composer.waitFor({ state: "visible", timeout: 30000 });
    const cookies = await page.context().cookies(API);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const startRes = await fetch(`${API}/v1/demo-tape/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: JSON.stringify({ tape_id: TAPE, speed: SPEED, max_gap_ms: GAP }),
    });
    if (!startRes.ok) throw new Error(await startRes.text());
    const { conversation_id: cid } = await startRes.json();
    await page.goto(new URL(`index.webapp.html#/conversations/${cid}`, base).href, {
      waitUntil: "load",
      timeout: 30000,
    });
    await page.getByRole("button", { name: /授权开赛/ }).first().waitFor({ state: "visible", timeout: 60000 });
    await page.getByRole("button", { name: /授权开赛/ }).first().click();
    console.log("authorized", cid);

    for (let i = 0; i < 60; i++) {
      const open = page.getByRole("button", { name: /打开辩论室/ });
      if (await open.first().isVisible().catch(() => false)) {
        await open.first().click();
        break;
      }
      if (await page.getByRole("button", { name: /^辩论室$/ }).isVisible().catch(() => false)) break;
      await page.waitForTimeout(500);
    }
    await page.getByRole("button", { name: /^辩论室$/ }).click().catch(() => {});

    // Wait until round-5 chapter chip exists (debate settled enough)
    for (let i = 0; i < 180; i++) {
      const r5 = page.getByRole("button", { name: "第5轮", exact: true });
      if (await r5.isVisible().catch(() => false)) {
        console.log("r5 chip visible at", i);
        break;
      }
      if (i % 15 === 0) console.log("waiting r5 chip", i);
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(2000);

    for (const job of JOBS) {
      const chipLabel = `第${job.round}轮`;
      console.log("→", job.id, chipLabel);
      const chip = page.getByRole("button", { name: chipLabel, exact: true });
      if (!(await chip.isVisible().catch(() => false))) {
        result.miss.push({ id: job.id, reason: `chip ${chipLabel} missing` });
        continue;
      }
      await chip.click();
      await page.waitForTimeout(800);

      // Anchor id is on SectionHeader only; round body is the parent <div key=round>.
      const anchored = await page.evaluate((round) => {
        const header = document.getElementById(`debate-round-${round}`);
        const section = header?.parentElement;
        if (!section) return false;
        section.scrollIntoView({ block: "start" });
        return true;
      }, job.round);
      if (!anchored) {
        result.miss.push({ id: job.id, reason: `missing #debate-round-${job.round}` });
        console.log("MISS", job.id, "no anchor");
        continue;
      }
      await page.waitForTimeout(500);

      await page.evaluate((round) => {
        const section = document.getElementById(`debate-round-${round}`)?.parentElement;
        if (!section) return;
        section.querySelectorAll("button").forEach((b) => {
          if (/展开全文/.test(b.textContent || "")) b.click();
        });
      }, job.round);
      await page.waitForTimeout(500);

      const blobInfo = await page.evaluate((job) => {
        const section = document.getElementById(`debate-round-${job.round}`)?.parentElement;
        const blob = (section?.innerText || "").replace(/\s+/g, " ");
        const hit = job.anyOf
          ? job.needles.some((n) => blob.includes(n))
          : job.needles.every((n) => blob.includes(n));
        return { hit, len: blob.length, snip: blob.slice(0, 160) };
      }, job);
      console.log("section", job.id, blobInfo);

      // Pin round section at top — do NOT wheel further (avoids spilling into 结辩).
      await page.evaluate((round) => {
        document.getElementById(`debate-round-${round}`)?.parentElement?.scrollIntoView({
          block: "start",
        });
      }, job.round);
      await page.waitForTimeout(400);

      const path = resolve(stillsDir, `${job.id}.png`);
      await page.screenshot({ path, fullPage: false });
      if (blobInfo.hit) {
        result.ok.push(job.id);
        console.log("OK", job.id);
      } else {
        result.miss.push({
          id: job.id,
          reason: `needles not in round parent (len=${blobInfo.len})`,
          snip: blobInfo.snip,
        });
        console.log("MISS", job.id);
      }
    }
  } catch (e) {
    result.fatal = String(e?.stack ?? e);
    console.error(result.fatal);
  } finally {
    await browser.close();
    await server.close();
  }
  console.log("ROUNDS", JSON.stringify(result));
  process.exitCode = result.fatal || result.miss.length ? 1 : 0;
}

main();
