/**
 * Fixup stills that need scroll-into-view: R2 quote close-up + final verdict.
 * Uses production webapp + live tape replay (same clean env as main capture).
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const root = resolve(desktopDir, "../..");
const stillsDir = resolve(root, "apps/promo/assets/lv-molihua/stills");
const outRoot = resolve(root, "apps/promo/assets/lv-molihua");
const API = (process.env.PROMO_API ?? "http://localhost:8015").replace(/\/$/, "");
const PORT = Number(process.env.PROMO_PORT ?? 5174);
const USER = process.env.PROMO_USER ?? "promo_lv";
const PASS = process.env.PROMO_PASS ?? "promopass";
const SPEED = Number(process.env.PROMO_SPEED ?? 16);
const GAP = Number(process.env.PROMO_GAP ?? 500);
const TAPE = "lv-molihua-trademark";
const QUOTE = "对方在拿“菱形”论证“正方形”";
process.env.VITE_API_URL = API;

async function dismissOnboarding(page) {
  const dialog = page.locator('[aria-label="欢迎使用 AgentCore"]');
  if (!(await dialog.isVisible().catch(() => false))) return;
  const skip = dialog.getByRole("button", { name: /^跳过$/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
}

async function ensureDebateRoom(page) {
  const debateTab = page.getByRole("button", { name: /^辩论室$/ });
  if (await debateTab.isVisible().catch(() => false)) {
    await debateTab.click();
    await page.waitForTimeout(500);
  } else {
    const open = page.getByRole("button", { name: /打开辩论室/ });
    if (await open.first().isVisible().catch(() => false)) {
      await open.first().click();
      await page.waitForTimeout(1000);
    }
  }
}

async function scrollQuoteIntoView(page) {
  return page.evaluate((quote) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      if (node.textContent && node.textContent.includes("对方在拿") && node.textContent.includes("菱形")) {
        const el = node.parentElement;
        if (el) {
          el.scrollIntoView({ block: "center", inline: "nearest" });
          return el.innerText.slice(0, 200);
        }
      }
    }
    // fallback: any element containing both
    const all = [...document.querySelectorAll("p, li, div, span")];
    for (const el of all) {
      const t = el.innerText || "";
      if (t.includes("对方在拿") && t.includes("菱形") && t.includes("正方形")) {
        el.scrollIntoView({ block: "center" });
        return t.slice(0, 200);
      }
    }
    return null;
  }, QUOTE);
}

async function scrollVerdictIntoView(page) {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll("p, li, div, span, h1, h2, h3")];
    for (const el of all) {
      const t = el.innerText || "";
      if (t.includes("倾向茉莉奶白") && (t.includes("置信") || t.includes("65"))) {
        el.scrollIntoView({ block: "center" });
        return t.slice(0, 200);
      }
    }
    for (const el of all) {
      if ((el.innerText || "").includes("倾向茉莉奶白")) {
        el.scrollIntoView({ block: "center" });
        return el.innerText.slice(0, 200);
      }
    }
    return null;
  });
}

async function main() {
  process.chdir(desktopDir);
  await mkdir(stillsDir, { recursive: true });
  const report = { ok: false, shots: [], notes: [] };

  const server = await preview({
    configFile: resolve(desktopDir, "vite.webapp.config.ts"),
    preview: { port: PORT, strictPort: true },
  });
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

  try {
    await page.goto(new URL("index.webapp.html", base).href, {
      waitUntil: "load",
      timeout: 30_000,
    });
    const userBox = page.getByPlaceholder("用户名");
    const composer = page.getByPlaceholder(/输入消息/);
    await Promise.race([
      userBox.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {}),
      composer.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {}),
    ]);
    if (await userBox.isVisible().catch(() => false)) {
      await userBox.fill(USER);
      await page.getByPlaceholder(/密码/).first().fill(PASS);
      await page.locator('button[type="submit"]').click();
    }
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    await dismissOnboarding(page);

    const cookies = await page.context().cookies(API);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const headers = {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    };

    const prep = await fetch(`${API}/v1/demo-tape/prepare`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tape_id: TAPE, speed: SPEED, max_gap_ms: GAP }),
    });
    if (!prep.ok) throw new Error(await prep.text());
    const { conversation_id: cid, user_prompt: prompt } = await prep.json();
    await page.goto(new URL(`index.webapp.html#/conversations/${cid}`, base).href, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    await dismissOnboarding(page);
    await composer.fill(prompt || "搜索下最新的LV起诉茉莉奶白这个案件、简单向我介绍之后启动模拟庭审辩论");
    await composer.press("Enter");

    // wait authorize + click
    for (let i = 0; i < 120; i++) {
      const auth = page.getByRole("button", { name: /授权开赛|授权并开工/ });
      if (await auth.first().isVisible().catch(() => false)) {
        await auth.first().click();
        break;
      }
      await page.waitForTimeout(400);
    }

    let quoteDone = false;
    let verdictDone = false;
    const deadline = Date.now() + 12 * 60_000;

    while (Date.now() < deadline && (!quoteDone || !verdictDone)) {
      await ensureDebateRoom(page);
      const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));

      if (!quoteDone && body.includes("对方在拿") && body.includes("菱形") && body.includes("正方形")) {
        const ctx = await scrollQuoteIntoView(page);
        await page.waitForTimeout(400);
        const path = resolve(stillsDir, "04b-r2-quote-closeup.png");
        await page.screenshot({ path, type: "png" });
        // also refresh 04
        await page.screenshot({
          path: resolve(stillsDir, "04-r2-diamond-square.png"),
          type: "png",
        });
        report.shots.push({ id: "04b-r2-quote-closeup", path, ctx });
        report.shots.push({
          id: "04-r2-diamond-square",
          path: resolve(stillsDir, "04-r2-diamond-square.png"),
          ctx,
        });
        quoteDone = true;
        console.log("SHOT 04b", ctx?.slice(0, 80));
      }

      if (!verdictDone && /倾向茉莉奶白/.test(body) && /置信|65/.test(body)) {
        // click 终审 chip if present
        const verdictChip = page.getByRole("button", { name: /终审|裁决/ });
        if (await verdictChip.first().isVisible().catch(() => false)) {
          await verdictChip.first().click().catch(() => {});
          await page.waitForTimeout(600);
        }
        const ctx = await scrollVerdictIntoView(page);
        await page.waitForTimeout(400);
        const path = resolve(stillsDir, "08-final-verdict.png");
        await page.screenshot({ path, type: "png" });
        report.shots.push({ id: "08-final-verdict", path, ctx });
        verdictDone = true;
        console.log("SHOT 08", ctx?.slice(0, 80));
      }

      await page.waitForTimeout(500);
    }

    report.ok = quoteDone && verdictDone;
    report.notes.push(`quoteDone=${quoteDone} verdictDone=${verdictDone}`);

    // patch MANIFEST notes
    try {
      const manPath = resolve(outRoot, "manifest.json");
      const man = JSON.parse(await readFile(manPath, "utf8"));
      man.fixup = report;
      man.notes = man.notes || [];
      man.notes.push(
        `fixup ${new Date().toISOString()}: quote=${quoteDone} verdict=${verdictDone}`,
      );
      await writeFile(manPath, JSON.stringify(man, null, 2), "utf8");
    } catch (e) {
      report.notes.push(String(e));
    }
  } catch (e) {
    report.fatal = String(e?.stack || e);
    console.error(report.fatal);
  } finally {
    await browser.close();
    await server.close();
  }

  await writeFile(
    resolve(outRoot, "fixup-report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log("FIXUP", JSON.stringify({ ok: report.ok, shots: report.shots.map((s) => s.id) }));
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
