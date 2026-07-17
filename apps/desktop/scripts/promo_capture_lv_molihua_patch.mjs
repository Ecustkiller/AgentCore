/**
 * Patch pass: after (or during) a full tape replay, navigate debate-room
 * chapter chips (第N轮 / 终审) to capture mid-round stills that live-poll misses.
 *
 * Does NOT wipe existing assets — only overwrites targeted stills.
 *
 *   $env:PROMO_API='http://localhost:8015'
 *   node apps/desktop/scripts/promo_capture_lv_molihua_patch.mjs
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const root = resolve(desktopDir, "../..");
const outRoot = resolve(root, "apps/promo/assets/lv-molihua");
const stillsDir = resolve(outRoot, "stills");
const sequencesDir = resolve(outRoot, "sequences");

const USER = process.env.PROMO_USER ?? "dev";
const PASS = process.env.PROMO_PASS ?? "devpassword";
const API = (process.env.PROMO_API ?? "http://localhost:8015").replace(/\/$/, "");
const PORT = Number(process.env.PROMO_PORT ?? 5175);
const TAPE = process.env.PROMO_TAPE ?? "lv-molihua-trademark";
const SPEED = Number(process.env.PROMO_SPEED ?? 20);
const GAP = Number(process.env.PROMO_GAP ?? 400);
const VIEWPORT = { width: 1920, height: 1080 };

process.env.VITE_API_URL = API;

const TARGETS = [
  {
    id: "04-r2-diamond-square",
    chapter: /第\s*2\s*轮|第2轮/,
    need: (t) => /菱形/.test(t) && /正方形/.test(t),
    label: "第2轮 LV「拿菱形论证正方形」",
    tapeHint: "r2_lv @ t_ms≈432000",
  },
  {
    id: "05-r3-logo-swap",
    chapter: /第\s*3\s*轮|第3轮/,
    need: (t) => /更换Logo|换标|诉讼期间/.test(t) && /混淆|恶意|门店/.test(t),
    label: "第3轮 诉讼期换标攻防",
    tapeHint: "r3_lv @ t_ms≈657000",
  },
  {
    id: "05b-r4-logo-defense",
    chapter: /第\s*4\s*轮|第4轮/,
    need: (t) => /小程序/.test(t) && /客服头像/.test(t),
    label: "第4轮 换标抗辩（小程序/客服头像）",
    tapeHint: "r4_molij @ t_ms≈825000",
  },
  {
    id: "06-r5-burden",
    chapter: /第\s*5\s*轮|第5轮/,
    need: (t) => /举证|间接证据|实际混淆|定量调查/.test(t),
    label: "第5轮 举证责任决胜",
    tapeHint: "r5 @ t_ms≈1058000",
  },
  {
    id: "08-final-verdict",
    chapter: /终审/,
    // UI shows「置信 中」pill + leaning line; CEO wrap may also say 65%.
    need: (t) =>
      /倾向茉莉奶白/.test(t) && (/置信/.test(t) || /65\s*%|65%/.test(t) || /决策简报/.test(t)),
    label: "最终裁决（倾向茉莉奶白 · 65%）",
    tapeHint: "debate_result @ t_ms≈1118000",
  },
];

async function mainText(page) {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("aside, nav, [class*=Sidebar], [class*=sidebar]").forEach((el) => el.remove());
    return (clone.innerText || "").replace(/\s+/g, " ");
  });
}

async function shot(page, id) {
  const path = resolve(stillsDir, `${id}.png`);
  await page.screenshot({ path, fullPage: false, type: "png" });
  return path;
}

async function clickChapter(page, re) {
  // Scoreboard chapter buttons
  const btn = page.getByRole("button", { name: re }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(900);
    return true;
  }
  // Fallback: any clickable with that label
  const any = page.locator("button, a, [role=tab]").filter({ hasText: re }).first();
  if (await any.isVisible().catch(() => false)) {
    await any.click();
    await page.waitForTimeout(900);
    return true;
  }
  return false;
}

async function denseSequence(page, dir, prefix, count, intervalMs) {
  await mkdir(dir, { recursive: true });
  const paths = [];
  for (let i = 0; i < count; i++) {
    const path = resolve(dir, `${prefix}-${String(i).padStart(2, "0")}.png`);
    await page.screenshot({ path, fullPage: false, type: "png" });
    paths.push(path);
    if (i < count - 1) await page.waitForTimeout(intervalMs);
  }
  return paths;
}

async function main() {
  process.chdir(desktopDir);
  await mkdir(stillsDir, { recursive: true });
  await mkdir(sequencesDir, { recursive: true });

  const report = {
    generated_at: new Date().toISOString(),
    mode: "patch-chapter-nav",
    speed: SPEED,
    gap: GAP,
    patched: [],
    missing: [],
    sequences: [],
    ok: false,
  };

  const server = await createServer({
    configFile: resolve(desktopDir, "vite.webapp.config.ts"),
    logLevel: "warn",
    server: { port: PORT, strictPort: true },
  });
  await server.listen();
  const base = server.resolvedUrls?.local?.[0];
  console.log(`patch webapp ${base} → ${API}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
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
    if (!startRes.ok) {
      throw new Error(`start failed ${startRes.status}: ${await startRes.text()}`);
    }
    const body = await startRes.json();
    const cid = body.conversation_id;
    console.log("autostarted (paused at team_preview)", cid);
    await page.goto(new URL(`index.webapp.html#/conversations/${cid}`, base).href, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await page.waitForTimeout(1500);

    const auth = page.getByRole("button", { name: /授权开赛/ });
    await auth.first().waitFor({ state: "visible", timeout: 60_000 });
    await auth.first().click();
    console.log("authorized");

    // Open debate room
    for (let i = 0; i < 40; i++) {
      const open = page.getByRole("button", { name: /打开辩论室/ });
      if (await open.first().isVisible().catch(() => false)) {
        await open.first().click();
        break;
      }
      if (await page.getByRole("button", { name: /^辩论室$/ }).isVisible().catch(() => false)) {
        await page.getByRole("button", { name: /^辩论室$/ }).click();
        break;
      }
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1000);

    // Capture streaming sequence early (round 1 typing)
    const streamSeqDir = resolve(sequencesDir, "clip-streaming-debate");
    console.log("capturing streaming sequence…");
    const streamPaths = await denseSequence(page, streamSeqDir, "clip-streaming-debate", 12, 800);
    report.sequences.push({
      id: "clip-streaming-debate",
      dir: streamSeqDir,
      files: streamPaths,
      label: "流式打字中的辩论发言",
    });

    // Wait until finale / round 5 chapter exists (debate far enough)
    console.log("waiting for late chapters…");
    let ready = false;
    for (let i = 0; i < 240; i++) {
      const t = await mainText(page);
      const hasFinale =
        (await page.getByRole("button", { name: /终审/ }).isVisible().catch(() => false)) ||
        /终审|倾向茉莉奶白|决策简报/.test(t);
      const hasR5 = await page.getByRole("button", { name: /第\s*5\s*轮|第5轮/ }).isVisible().catch(() => false);
      if (i % 20 === 0) console.log("wait", i, { hasFinale, hasR5, len: t.length });
      if (hasFinale || (hasR5 && /倾向茉莉奶白|已收敛|决策简报/.test(t))) {
        ready = true;
        break;
      }
      // Keep debate room focused
      const tab = page.getByRole("button", { name: /^辩论室$/ });
      if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
    if (!ready) console.warn("late chapters not confirmed; attempting chapter nav anyway");

    // Extra settle for CEO wrap / brief to hydrate
    await page.waitForTimeout(3000);

    for (const target of TARGETS) {
      console.log("chapter", target.id);
      const clicked = await clickChapter(page, target.chapter);
      if (!clicked) {
        // Scroll search in page
        await page.evaluate((label) => {
          const el = [...document.querySelectorAll("button, a, [role=tab], h2, h3")].find((n) =>
            label.test((n.textContent || "").replace(/\s+/g, "")),
          );
          el?.scrollIntoView({ block: "center" });
          if (el instanceof HTMLElement) el.click();
        }, target.chapter);
        await page.waitForTimeout(900);
      }

      let hit = false;
      for (let j = 0; j < 8; j++) {
        // Expand collapsed bodies if present
        const expand = page.getByRole("button", { name: /展开全文|展开/ });
        const n = await expand.count().catch(() => 0);
        for (let k = 0; k < Math.min(n, 4); k++) {
          await expand.nth(k).click().catch(() => {});
        }
        await page.waitForTimeout(400);
        const t = await mainText(page);
        if (target.need(t)) {
          const path = await shot(page, target.id);
          report.patched.push({
            id: target.id,
            path,
            label: target.label,
            tapeHint: target.tapeHint,
            snippet: t.match(/.{0,50}(?:菱形|正方形|换标|小程序|举证|倾向茉莉|置信度|证据缺口).{0,50}/)?.[0],
          });
          console.log("PATCHED", target.id);
          hit = true;
          break;
        }
        // Scroll down within debate pane
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(400);
      }
      if (!hit) {
        // Still save a chapter frame for manual review
        const path = await shot(page, `${target.id}-chapter`);
        report.missing.push({
          id: target.id,
          reason: "章节已打开但未匹配到关键句；已存 *-chapter.png 供人工筛",
          path,
        });
        console.log("MISS", target.id, "saved chapter frame");
      }
    }

    report.ok = TARGETS.every((t) => report.patched.some((p) => p.id === t.id));
  } catch (err) {
    report.fatal = String(err?.stack ?? err);
    console.error(report.fatal);
  } finally {
    await browser.close();
    await server.close();
  }

  // Merge into manifest.json if present
  const manifestPath = resolve(outRoot, "manifest.json");
  try {
    const prev = JSON.parse(await readFile(manifestPath, "utf8"));
    prev.patch = report;
    for (const p of report.patched) {
      const idx = (prev.assets || []).findIndex((a) => a.id === p.id);
      const entry = {
        id: p.id,
        file: `stills/${p.id}.png`,
        path: p.path,
        label: p.label,
        tape_hint: p.tapeHint,
        usage: "第五幕 / 冷开场（章节导航补采）",
        matched_text: p.snippet,
        source: "patch-chapter-nav",
      };
      if (idx >= 0) prev.assets[idx] = entry;
      else (prev.assets || (prev.assets = [])).push(entry);
      prev.missing = (prev.missing || []).filter((m) => m.id !== p.id);
      if (!prev.captured_ids?.includes(p.id)) {
        prev.captured_ids = [...(prev.captured_ids || []), p.id];
      }
    }
    for (const s of report.sequences) {
      if (!(prev.sequences || []).some((x) => x.id === s.id)) {
        (prev.sequences || (prev.sequences = [])).push(s);
      }
    }
    prev.ok =
      ["01-user-prompt", "02-team-preview", "03-debate-opening", "08-final-verdict"].every(
        (id) => (prev.captured_ids || []).includes(id),
      ) && report.ok;
    prev.generated_at_patch = report.generated_at;
    await writeFile(manifestPath, JSON.stringify(prev, null, 2), "utf8");
  } catch {
    await writeFile(resolve(outRoot, "patch-report.json"), JSON.stringify(report, null, 2), "utf8");
  }

  await writeFile(resolve(outRoot, "patch-report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log("PATCH", JSON.stringify({ ok: report.ok, patched: report.patched.map((p) => p.id), missing: report.missing.map((m) => m.id), fatal: report.fatal }));
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
