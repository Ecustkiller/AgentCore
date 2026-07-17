/**
 * Clean-env promo capture driven by demo-tape director console.
 *
 * - Serves production webapp build (dist-web) → no DEV badge (no product source change)
 * - Logs in as fresh promo_lv / 演示 (empty sidebar)
 * - Uses director REST: pause / speed / chapter seek / forward seek / rewind / cross-auth seek
 * - Overwrites stills + clips + MANIFEST under --out (default apps/promo/assets/lv-molihua/)
 *
 * Prereq:
 *   cd apps/desktop && $env:VITE_API_URL='http://localhost:8015'; pnpm build:webapp
 *   Backend on PROMO_API with DEMO_TAPE_REPLAY_ENABLED=true
 *
 * Run:
 *   $env:PROMO_API='http://localhost:8015'
 *   node apps/desktop/scripts/promo_capture_lv_molihua_director.mjs
 *   node apps/desktop/scripts/promo_capture_lv_molihua_director.mjs --tape <tape-id>
 *   node apps/desktop/scripts/promo_capture_lv_molihua_director.mjs --tape <id> --out apps/promo/assets/<dir>
 *
 * Env aliases: PROMO_TAPE / PROMO_OUT.
 */

import { mkdir, rm, writeFile, copyFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { preview } from "vite";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const root = resolve(desktopDir, "../..");
const distWeb = resolve(desktopDir, "dist-web");

const DEFAULT_TAPE = "lv-molihua-trademark";
const DEFAULT_OUT_REL = "apps/promo/assets/lv-molihua";

function parsePromoArgs(argv) {
  const out = { help: false, tape: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--tape") out.tape = argv[++i];
    else if (a?.startsWith("--tape=")) out.tape = a.slice("--tape=".length);
    else if (a === "--out") out.out = argv[++i];
    else if (a?.startsWith("--out=")) out.out = a.slice("--out=".length);
    else throw new Error(`Unknown arg: ${a} (use --tape / --out / --help)`);
  }
  return out;
}

const cli = parsePromoArgs(process.argv.slice(2));
if (cli.help) {
  console.log(`Usage: node promo_capture_lv_molihua_director.mjs [--tape <id>] [--out <rel-or-abs>]

Defaults: --tape ${DEFAULT_TAPE}  --out ${DEFAULT_OUT_REL}
Env aliases: PROMO_TAPE / PROMO_OUT / PROMO_API / PROMO_SPEED / …`);
  process.exit(0);
}

const TAPE = cli.tape || process.env.PROMO_TAPE || DEFAULT_TAPE;
const outRel =
  cli.out ||
  process.env.PROMO_OUT ||
  (TAPE === DEFAULT_TAPE ? DEFAULT_OUT_REL : `apps/promo/assets/${TAPE}`);
const outRoot = resolve(root, outRel);
const stillsDir = resolve(outRoot, "stills");
const clipsDir = resolve(outRoot, "clips");
const sequencesDir = resolve(outRoot, "sequences");
const videoTmpDir = resolve(outRoot, "_video_tmp");

const USER = process.env.PROMO_USER ?? "promo_lv";
const PASS = process.env.PROMO_PASS ?? "promopass";
const API = (process.env.PROMO_API ?? "http://localhost:8015").replace(/\/$/, "");
const PORT = Number(process.env.PROMO_PORT ?? 5174);
const CAPTURE_SPEED = Number(process.env.PROMO_SPEED ?? 8); // director max 8
const GAP = Number(process.env.PROMO_GAP ?? 800);
const HEADED = process.env.PROMO_HEADED === "1";
const VIEWPORT = { width: 1920, height: 1080 };

const QUOTE = "不是四叶草不能用，而是用得太像";
const QUOTE_ALT = "不是四叶草不能用，而是用得太像";
const QUOTE_T_MS = 495900;

function nowIso() {
  return new Date().toISOString();
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function dismissOnboarding(page) {
  const dialog = page.locator('[aria-label="欢迎使用 AgentCore"]');
  if (!(await dialog.isVisible().catch(() => false))) return false;
  // Header「跳过」always present; free-tier CTA only on connect step.
  const skip = dialog.getByRole("button", { name: /^跳过$/ });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  } else {
    const free = dialog.getByRole("button", { name: /先用免费额度/ });
    if (await free.isVisible().catch(() => false)) await free.click();
  }
  await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

async function ensureDebateRoom(page) {
  const debateTab = page.getByRole("button", { name: /^辩论室$/ });
  if (await debateTab.isVisible().catch(() => false)) {
    await debateTab.click();
    await page.waitForTimeout(700);
    return;
  }
  const open = page.getByRole("button", { name: /打开辩论室/ });
  if (await open.first().isVisible().catch(() => false)) {
    await open.first().click();
    await page.waitForTimeout(1200);
  }
}

async function ensureCollabGraph(page) {
  const graphTab = page.getByRole("button", { name: /^协作图$/ });
  if (await graphTab.isVisible().catch(() => false)) {
    await graphTab.click();
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

async function hardReloadConversation(page, base, cid) {
  // Director seek/rewind mutates server transcript; SPA often keeps stale fold
  // until a full remount. Bounce via home so the conversation route remounts.
  const home = new URL("index.webapp.html#/", base).href;
  const dest = new URL(`index.webapp.html#/conversations/${cid}`, base).href;
  await page.goto(home, { waitUntil: "load", timeout: 30_000 });
  await page.waitForTimeout(500);
  await dismissOnboarding(page);
  await page.goto(dest, { waitUntil: "load", timeout: 30_000 });
  await page.waitForTimeout(1200);
  await dismissOnboarding(page);
}

async function refreshViaSidebar(page, cid, base) {
  if (base) {
    await hardReloadConversation(page, base, cid);
    return;
  }
  const convLink = page.locator(`a[href*="${cid}"], [data-conversation-id="${cid}"]`).first();
  if (await convLink.isVisible().catch(() => false)) {
    await page.goto(new URL("index.webapp.html#/", page.url()).href, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await page.waitForTimeout(400);
    await convLink.click().catch(() => {});
    await page.waitForTimeout(800);
    return;
  }
  await page.goto(new URL(`index.webapp.html#/conversations/${cid}`, page.url()).href, {
    waitUntil: "load",
    timeout: 30_000,
  });
  await page.waitForTimeout(800);
}

async function probe(page) {
  return page.evaluate(() => {
    const clone = document.body?.cloneNode(true);
    if (clone) {
      for (const sel of [
        "aside",
        "nav",
        "[data-sidebar]",
        '[class*="Sidebar"]',
        '[class*="sidebar"]',
      ]) {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      }
    }
    const root = clone || document.body;
    const text = (root?.innerText ?? "").replace(/\s+/g, " ");
    const full = (document.body?.innerText ?? "").replace(/\s+/g, " ");
    const nodeText = Array.from(document.querySelectorAll(".react-flow__node"))
      .map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())
      .join(" | ");
    const hasDevBadge = /\bDEV\b/.test(
      document.body?.innerText?.slice(0, 400) ?? "",
    );
    const accountSnippet = (
      document.querySelector('[class*="UserMenu"], [data-user-menu], aside')
        ?.innerText ?? ""
    )
      .replace(/\s+/g, " ")
      .slice(0, 120);
    return {
      text,
      textLen: text.length,
      snippet: text.slice(0, 900),
      streaming: /停止生成/.test(full),
      authorize: /授权开赛|授权并开工/.test(full),
      waitKickoff: /等待开工确认|开工卡/.test(full),
      debate:
        (/主持人/.test(text) && /立论|辩题|正方|反方/.test(text)) ||
        (/打开辩论室|辩论室/.test(full) && /第\s*[1-5]\s*轮/.test(text)),
      reactFlow: document.querySelectorAll(".react-flow").length,
      reactFlowNodes: document.querySelectorAll(".react-flow__node").length,
      nodeText: nodeText.slice(0, 600),
      hasDevBadge,
      accountSnippet,
      hasQuote:
        text.includes("不是四叶草不能用") ||
        (text.includes("四叶草") && text.includes("用得太像")),
      quoteContext:
        text.match(/.{0,24}不是四叶草不能用.{0,40}/)?.[0] ??
        text.match(/.{0,20}四叶草.{0,30}用得太像.{0,20}/)?.[0] ??
        null,
      roundNo: (() => {
        const nums = [...text.matchAll(/第\s*([1-5])\s*轮/g)].map((m) =>
          Number(m[1]),
        );
        return nums.length ? String(Math.max(...nums)) : null;
      })(),
      sidebarConvCount: document.querySelectorAll(
        "aside a[href*='conversations'], [data-sidebar] a[href*='conversations']",
      ).length,
    };
  });
}

async function shot(page, absPath) {
  await page.screenshot({ path: absPath, fullPage: false, type: "png" });
  return absPath;
}

function authHeaders(cookieHeader, csrf) {
  return {
    "Content-Type": "application/json",
    Cookie: cookieHeader,
    ...(csrf ? { "X-CSRF-Token": csrf } : {}),
  };
}

async function director(api, cookieHeader, csrf, cid, method, path, body) {
  const url = `${api}/v1/demo-tape/director/${cid}${path}`;
  const res = await fetch(url, {
    method,
    headers: authHeaders(cookieHeader, csrf),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain */
  }
  if (!res.ok) {
    throw new Error(`director ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function waitStatus(api, cookieHeader, csrf, cid, pred, { timeoutMs = 60_000, label = "status" } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await director(api, cookieHeader, csrf, cid, "GET", "/status");
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timeout waiting ${label}; last=${JSON.stringify(last)}`);
}

async function waitUi(page, pred, { timeoutMs = 90_000, label = "ui" } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await probe(page);
    if (pred(last)) return last;
    await page.waitForTimeout(500);
  }
  throw new Error(`timeout waiting ${label}; snippet=${last?.snippet?.slice(0, 160)}`);
}

async function clickAuthorize(page) {
  const authBtn = page.getByRole("button", { name: /授权开赛|授权并开工|开做/ });
  if (await authBtn.first().isVisible().catch(() => false)) {
    await authBtn.first().click();
    await page.waitForTimeout(800);
    return true;
  }
  return false;
}

async function main() {
  process.chdir(desktopDir);

  if (!(await exists(resolve(distWeb, "index.webapp.html")))) {
    throw new Error(
      `Missing ${distWeb}/index.webapp.html — run: $env:VITE_API_URL='${API}'; pnpm build:webapp`,
    );
  }

  if (process.env.PROMO_WIPE !== "0") {
    await rm(outRoot, { recursive: true, force: true });
  }
  await mkdir(stillsDir, { recursive: true });
  await mkdir(clipsDir, { recursive: true });
  await mkdir(sequencesDir, { recursive: true });
  await mkdir(videoTmpDir, { recursive: true });

  const report = {
    generated_at: nowIso(),
    clean_env: {
      webapp: "production dist-web via vite preview (import.meta.env.DEV=false)",
      user: USER,
      display_name_expected: "演示",
      api: API,
      no_product_source_change: true,
    },
    director_acceptance: [],
    assets: [],
    clips: [],
    sequences: [],
    missing: [],
    notes: [],
    ok: false,
  };

  const mark = (entry) => {
    report.assets.push(entry);
    console.log("SHOT", entry.id, entry.path);
  };
  const noteDir = (entry) => {
    report.director_acceptance.push(entry);
    console.log("DIR", entry.feature, entry.result, entry.detail ?? "");
  };

  const server = await preview({
    configFile: resolve(desktopDir, "vite.webapp.config.ts"),
    preview: { port: PORT, strictPort: true },
  });
  const base = server.resolvedUrls?.local?.[0];
  if (!base) {
    await server.close();
    throw new Error("vite preview did not report a local URL");
  }
  console.log(`prod webapp ${base} → api ${API}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "zh-CN",
    recordVideo: { dir: videoTmpDir, size: VIEWPORT },
  });
  const page = await context.newPage();
  let csrf = null;
  page.on("response", (r) => {
    const t = r.headers()["x-csrf-token"];
    if (t) csrf = t;
  });
  page.on("pageerror", (e) => report.notes.push(`pageerror: ${e.message}`));

  let cookieHeader = "";
  let cid = null;
  let wall0 = Date.now();

  try {
    const health = await fetch(`${API}/readyz`).catch(() => null);
    if (!health?.ok) {
      throw new Error(`Backend not ready at ${API}/readyz`);
    }

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

    // Fresh promo account hits first-run onboarding (free-tier path). Dismiss it.
    await dismissOnboarding(page);

    const cookies = await context.cookies(API);
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Wipe prior sessions so the sidebar stays clean for stills.
    try {
      const lst = await fetch(`${API}/v1/conversations?limit=100`, {
        headers: authHeaders(cookieHeader, csrf),
      });
      if (lst.ok) {
        const body = await lst.json();
        const items = body.data || body.items || [];
        for (const it of items) {
          const id = it.id || it.conversation_id;
          if (!id) continue;
          await fetch(`${API}/v1/conversations/${id}`, {
            method: "DELETE",
            headers: authHeaders(cookieHeader, csrf),
          });
        }
        report.notes.push(`cleaned ${items.length} prior conversations`);
      }
      await page.reload({ waitUntil: "load" });
      await dismissOnboarding(page);
      await composer.waitFor({ state: "visible", timeout: 20_000 });
    } catch (e) {
      report.notes.push(`conversation cleanup: ${e.message || e}`);
    }

    // Hygiene check before any tape session
    const hygiene = await probe(page);
    report.clean_env.has_dev_badge = hygiene.hasDevBadge;
    report.clean_env.account_snippet = hygiene.accountSnippet;
    report.clean_env.sidebar_conv_count_before = hygiene.sidebarConvCount;
    if (hygiene.hasDevBadge) {
      report.notes.push(
        "WARN: DEV badge still visible in production build — unexpected; stills may show DEV",
      );
    } else {
      report.notes.push("DEV badge absent (production build OK)");
    }
    if (/Dev\b/.test(hygiene.accountSnippet) && !/演示/.test(hygiene.accountSnippet)) {
      report.notes.push(`Account label may still show Dev: ${hygiene.accountSnippet}`);
    }

    const prepRes = await fetch(`${API}/v1/demo-tape/prepare`, {
      method: "POST",
      headers: authHeaders(cookieHeader, csrf),
      body: JSON.stringify({
        tape_id: TAPE,
        speed: CAPTURE_SPEED,
        max_gap_ms: GAP,
      }),
    });
    if (!prepRes.ok) {
      throw new Error(`prepare failed ${prepRes.status}: ${await prepRes.text()}`);
    }
    const prep = await prepRes.json();
    cid = prep.conversation_id;
    const prompt = prep.user_prompt ||
      "搜索下最新的LV起诉茉莉奶白这个案件、简单向我介绍之后启动模拟庭审辩论";
    console.log("prepared", cid);

    await page.goto(new URL(`index.webapp.html#/conversations/${cid}`, base).href, {
      waitUntil: "load",
      timeout: 30_000,
    });
    // The grouped conversation list is fetched once at shell mount — before `prepare`
    // created this cid — and a hash-only goto is a same-document nav that never
    // re-fetches it, so this bound session is absent from the cache and ChatView
    // falls back to the bottom composer. A full reload re-boots the app at this route,
    // re-fetching the list (now carrying the 0-message tape conversation) so the opening
    // shot renders the real product's centered welcome card (居中卡片), not the底栏.
    await page.reload({ waitUntil: "load", timeout: 30_000 });
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    await dismissOnboarding(page);
    // Wait for the centered composer dock so 01-user-prompt is the welcome card, not
    // the bottom bar (best-effort: falls back to whatever renders on timeout).
    await page
      .locator('[data-composer-dock="center"]')
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .catch(() => {});
    await page.waitForTimeout(500);

    // ── 01 user prompt ──
    await composer.click({ force: true });
    await composer.fill("");
    await composer.pressSequentially(prompt, { delay: 6 });
    await page.waitForTimeout(300);
    {
      const path = resolve(stillsDir, "01-user-prompt.png");
      await shot(page, path);
      mark({
        id: "01-user-prompt",
        file: "stills/01-user-prompt.png",
        path,
        label: "用户输入开场 prompt",
        usage: "第二幕 · 一句话发起",
        tape_t_ms: 0,
        clean: true,
      });
    }

    wall0 = Date.now();
    await composer.press("Enter");
    console.log("sent; waiting team_preview…");

    // Natural wait for authorize card (also exercises live play before director)
    await waitUi(
      page,
      (p) => p.authorize || p.waitKickoff,
      { timeoutMs: 120_000, label: "team_preview card" },
    );
    {
      const path = resolve(stillsDir, "02-team-preview.png");
      await shot(page, path);
      mark({
        id: "02-team-preview",
        file: "stills/02-team-preview.png",
        path,
        label: "开工卡 / 授权开赛",
        usage: "第四幕组队+授权；冷开场可闪",
        tape_t_ms: 32_000,
        clean: true,
      });
    }

    // ════════ Director acceptance ════════
    // Leave authorize card by chapter-jump first (also exercises cross-auth seek),
    // THEN pause/speed while metronome is in a playing chapter.
    {
      const chapters = await director(API, cookieHeader, csrf, cid, "GET", "/chapters");
      report.chapters = chapters?.chapters ?? [];
      const uiBefore = await probe(page);
      await director(API, cookieHeader, csrf, cid, "POST", "/seek", {
        chapter_id: "r1_argument",
      });
      await waitStatus(
        API,
        cookieHeader,
        csrf,
        cid,
        (s) => (s.chapter_label || "").includes("第1轮") || Number(s.t_ms) >= 50000,
        { timeoutMs: 90_000, label: "chapter r1_argument" },
      );
      await hardReloadConversation(page, base, cid);
      await ensureDebateRoom(page);
      let ui = await probe(page);
      let neededRefresh = ui.authorize && !ui.debate;
      if (neededRefresh) {
        await hardReloadConversation(page, base, cid);
        await ensureDebateRoom(page);
        ui = await probe(page);
      }
      noteDir({
        feature: "chapter_jump",
        result: ui.debate || Number(ui.roundNo) >= 1 || /正方|反方|立论/.test(ui.text)
          ? "pass"
          : "fail",
        detail: `debate=${ui.debate} round=${ui.roundNo} authorize=${ui.authorize}; hard_reload=true; before_auth=${uiBefore.authorize}`,
        needed_sidebar_refresh: neededRefresh,
      });
      noteDir({
        feature: "cross_auth_seek",
        result: !ui.authorize && (ui.debate || /正方|反方|第\s*1\s*轮/.test(ui.text))
          ? "pass"
          : ui.authorize
            ? "fail"
            : "partial",
        detail: `after seek past team_preview; authorize_card=${ui.authorize}; snippet=${ui.snippet.slice(0, 80)}`,
      });
      if (ui.debate || /正方|反方|立论|第\s*1\s*轮/.test(ui.text)) {
        const path = resolve(stillsDir, "03-debate-opening.png");
        await shot(page, path);
        mark({
          id: "03-debate-opening",
          file: "stills/03-debate-opening.png",
          path,
          label: "辩论室开场",
          usage: "冷开场 / 第五幕引入",
          tape_t_ms: 52_000,
          clean: true,
          director: "chapter_id=r1_argument + hardReload",
        });
      }
    }

    // Pause / speed / resume while past authorize (playing or soft-paused)
    {
      await director(API, cookieHeader, csrf, cid, "POST", "/resume", {});
      await director(API, cookieHeader, csrf, cid, "POST", "/speed", { speed: 4 });
      const before = await director(API, cookieHeader, csrf, cid, "GET", "/status");
      await director(API, cookieHeader, csrf, cid, "POST", "/pause", {});
      const after = await director(API, cookieHeader, csrf, cid, "GET", "/status");
      const ok = String(after.state).toLowerCase().includes("pause");
      noteDir({
        feature: "pause",
        result: ok ? "pass" : "fail",
        detail: `before=${before.state} after=${after.state} (tested after leaving team_preview)`,
      });
    }
    {
      await director(API, cookieHeader, csrf, cid, "POST", "/speed", { speed: 2 });
      let s = await director(API, cookieHeader, csrf, cid, "GET", "/status");
      const ok2 = Number(s.speed) === 2;
      await director(API, cookieHeader, csrf, cid, "POST", "/speed", { speed: 8 });
      s = await director(API, cookieHeader, csrf, cid, "GET", "/status");
      const ok8 = Number(s.speed) === 8;
      noteDir({
        feature: "speed",
        result: ok2 && ok8 ? "pass" : "partial",
        detail: `set 2→${ok2}; set 8→ speed=${s.speed}`,
      });
    }
    {
      await director(API, cookieHeader, csrf, cid, "POST", "/resume", {});
      const s = await director(API, cookieHeader, csrf, cid, "GET", "/status");
      noteDir({
        feature: "resume",
        result: String(s.state).toLowerCase().includes("pause") ? "fail" : "pass",
        detail: `state=${s.state}`,
      });
    }

    // Forward seek (t_ms into r1 score / evidence gap)
    {
      const tBefore = (await director(API, cookieHeader, csrf, cid, "GET", "/status")).t_ms;
      await director(API, cookieHeader, csrf, cid, "POST", "/seek", {
        t_ms: 319000,
      });
      const s = await waitStatus(
        API,
        cookieHeader,
        csrf,
        cid,
        (st) => Number(st.t_ms) >= 300000,
        { timeoutMs: 90_000, label: "forward seek 319000" },
      );
      await hardReloadConversation(page, base, cid);
      await ensureDebateRoom(page);
      let ui = await probe(page);
      for (let i = 0; i < 10 && !/证据缺口|均承认/.test(ui.text); i++) {
        await page.waitForTimeout(600);
        ui = await probe(page);
      }
      noteDir({
        feature: "forward_seek",
        result: Number(s.t_ms) >= 300000 ? "pass" : "fail",
        detail: `t_ms ${tBefore} → ${s.t_ms}; evidence_gap_visible=${/证据缺口/.test(ui.text)}; hard_reload=true`,
      });
      if (/证据缺口|均承认/.test(ui.text)) {
        const path = resolve(stillsDir, "07-evidence-gap-admit.png");
        await shot(page, path);
        mark({
          id: "07-evidence-gap-admit",
          file: "stills/07-evidence-gap-admit.png",
          path,
          label: "交叉质询摘要「双方均承认证据缺口」",
          usage: "质询高光",
          tape_t_ms: 319000,
          clean: true,
          director: "seek t_ms=319000 + hardReload",
        });
      } else {
        report.missing.push({
          id: "07-evidence-gap-admit",
          reason: `forward seek UI 无「证据缺口」; snippet=${ui.snippet.slice(0, 100)}`,
        });
      }
    }

    // Rewind (restart-style) → team_preview; check whether hard reload needed
    {
      const uiBefore = await probe(page);
      const textLenBefore = uiBefore.textLen;
      await director(API, cookieHeader, csrf, cid, "POST", "/seek", {
        chapter_id: "team_preview",
      });
      await waitStatus(
        API,
        cookieHeader,
        csrf,
        cid,
        (s) =>
          (s.chapter_label || "").includes("组队") ||
          Number(s.t_ms) <= 40000,
        { timeoutMs: 120_000, label: "rewind team_preview" },
      );
      await page.waitForTimeout(1500);
      let uiImmediate = await probe(page);
      const alignedImmediate =
        uiImmediate.authorize ||
        uiImmediate.waitKickoff ||
        (uiImmediate.textLen < textLenBefore * 0.5 && !/第\s*[2-5]\s*轮/.test(uiImmediate.text));

      let neededRefresh = !alignedImmediate;
      let uiAfterRefresh = uiImmediate;
      if (neededRefresh) {
        await hardReloadConversation(page, base, cid);
        uiAfterRefresh = await probe(page);
      }
      const alignedAfter =
        uiAfterRefresh.authorize ||
        uiAfterRefresh.waitKickoff ||
        Number(uiAfterRefresh.roundNo || 0) <= 1;

      noteDir({
        feature: "rewind",
        result: alignedAfter ? "pass" : "fail",
        detail: `immediate_aligned=${alignedImmediate}; after_hard_reload_aligned=${alignedAfter}; needed_manual_reload=${neededRefresh}`,
        needed_sidebar_refresh: neededRefresh,
        known_issue_confirmed: neededRefresh,
      });
    }

    // Seek to R2 quote zone (after rewind — crosses authorize again)
    {
      await director(API, cookieHeader, csrf, cid, "POST", "/speed", { speed: 8 });
      await director(API, cookieHeader, csrf, cid, "POST", "/seek", {
        t_ms: QUOTE_T_MS,
      });
      await waitStatus(
        API,
        cookieHeader,
        csrf,
        cid,
        (s) => Number(s.t_ms) >= QUOTE_T_MS - 2000,
        { timeoutMs: 120_000, label: "seek quote t_ms" },
      );
      await hardReloadConversation(page, base, cid);
      await ensureDebateRoom(page);
      let ui = await probe(page);
      for (let i = 0; i < 15 && !(ui.hasQuote || /四叶草不能用|用得太像|偷换概念/.test(ui.text)); i++) {
        // Try clicking round chip / expand speech
        const r2 = page.getByRole("button", { name: /第\s*2\s*轮/ });
        if (await r2.first().isVisible().catch(() => false)) {
          await r2.first().click().catch(() => {});
        }
        await page.waitForTimeout(700);
        ui = await probe(page);
      }

      const quoteOk = ui.hasQuote || /四叶草不能用|用得太像|偷换概念|具体设计/.test(ui.text);
      report.notes.push(
        quoteOk
          ? `R2 quote visible: ${ui.quoteContext || QUOTE}`
          : `R2 quote NOT in UI after seek+reload; actual: ${ui.snippet.slice(0, 160)}`,
      );

      if (quoteOk || /四叶草|偷换概念|公共纹样|具体设计/.test(ui.text)) {
        const path = resolve(stillsDir, "04-r2-diamond-square.png");
        await shot(page, path);
        mark({
          id: "04-r2-diamond-square",
          file: "stills/04-r2-diamond-square.png",
          path,
          label: "第2轮 · 公共纹样/具体设计交锋",
          usage: "交锋1",
          tape_t_ms: QUOTE_T_MS,
          clean: true,
          matched_text: ui.quoteContext || ui.snippet.slice(0, 140),
          director: `seek t_ms=${QUOTE_T_MS} + hardReload`,
        });
      }
      {
        const path = resolve(stillsDir, "04b-r2-quote-closeup.png");
        await shot(page, path);
        mark({
          id: "04b-r2-quote-closeup",
          file: "stills/04b-r2-quote-closeup.png",
          path,
          label: "R2 金句定点特写",
          usage: "交锋1 金句特写；须可见「不是四叶草不能用，而是用得太像」",
          tape_t_ms: QUOTE_T_MS,
          clean: true,
          quote_required: QUOTE,
          quote_visible: quoteOk,
          matched_text: ui.quoteContext ?? ui.snippet.slice(0, 160),
          new: true,
        });
        if (!quoteOk) {
          report.missing.push({
            id: "04b-r2-quote-closeup",
            reason: `画面未检出完整金句「${QUOTE}」；磁带有原文。实际 UI: ${ui.quoteContext ?? ui.snippet.slice(0, 120)}`,
          });
        }
      }
    }

    // Remaining chapter stills
    const chapterShots = [
      {
        id: "05-r3-logo-swap",
        chapter_id: "r3_argument",
        needles: [/惩罚性赔偿|驳回后|更近似|故意/],
        label: "第3轮 · 惩罚性赔偿 / 驳回后换标",
        usage: "交锋2",
        tape_t_ms: 600000,
      },
      {
        id: "05b-r4-logo-defense",
        chapter_id: "r4_argument",
        needles: [/贡献率|举证责任|量化/],
        all: true,
        label: "第4轮 · 贡献率举证责任",
        usage: "交锋3",
        tape_t_ms: 800000,
      },
      {
        id: "06-r5-burden",
        chapter_id: "r4_argument",
        needles: [/贡献率|举证责任|合理信赖|量化证据/],
        label: "第4轮终局 · 贡献率举证决胜",
        usage: "交锋3 决胜（本盘仅 4 轮）",
        tape_t_ms: 878000,
      },
      {
        id: "08-final-verdict",
        chapter_id: "verdict",
        needles: [/倾向支持一审|支持一审判决|70%/],
        label: "主持人终审 · 倾向支持一审",
        usage: "冷开场 / 第六幕裁决",
        tape_t_ms: 907528,
      },
    ];

    for (const job of chapterShots) {
      try {
        await director(API, cookieHeader, csrf, cid, "POST", "/seek", {
          chapter_id: job.chapter_id,
        });
        await waitStatus(
          API,
          cookieHeader,
          csrf,
          cid,
          (s) =>
            (s.chapter_label || "").includes(job.chapter_id.replace(/_.*/, "")) ||
            Number(s.t_ms) >= (job.tape_t_ms ?? 0) - 5000 ||
            s.state === "finished" ||
            s.state === "FINISHED",
          { timeoutMs: 120_000, label: `seek ${job.chapter_id}` },
        );
        await hardReloadConversation(page, base, cid);
        await ensureDebateRoom(page);
        let ui = await probe(page);
        for (let i = 0; i < 25; i++) {
          const ok = job.all
            ? job.needles.every((re) => re.test(ui.text))
            : job.needles.some((re) => re.test(ui.text));
          if (ok) break;
          const roundBtn = page.getByRole("button", {
            name: new RegExp(`第\\s*${job.chapter_id.match(/r(\d)/)?.[1] || ""}\\s*轮`),
          });
          if (await roundBtn.first().isVisible().catch(() => false)) {
            await roundBtn.first().click().catch(() => {});
          }
          await page.waitForTimeout(500);
          ui = await probe(page);
        }
        const matched = job.all
          ? job.needles.every((re) => re.test(ui.text))
          : job.needles.some((re) => re.test(ui.text));
        if (!matched && job.id !== "08-final-verdict") {
          report.missing.push({
            id: job.id,
            reason: `seek+reload 后未匹配 needles；snippet=${ui.snippet.slice(0, 120)}`,
          });
          console.error("MISS content", job.id, ui.snippet.slice(0, 100));
          continue;
        }
        if (job.id === "08-final-verdict" && !/倾向支持一审|支持一审判决|70\s*%/.test(ui.text)) {
          report.missing.push({
            id: job.id,
            reason: `无「倾向支持一审」；snippet=${ui.snippet.slice(0, 120)}`,
          });
          continue;
        }
        const path = resolve(stillsDir, `${job.id}.png`);
        await shot(page, path);
        mark({
          id: job.id,
          file: `stills/${job.id}.png`,
          path,
          label: job.label,
          usage: job.usage,
          tape_t_ms: job.tape_t_ms,
          clean: true,
          director: `chapter_id=${job.chapter_id} + hardReload`,
          matched_text: ui.snippet.slice(0, 140),
        });
      } catch (e) {
        report.missing.push({ id: job.id, reason: String(e.message || e) });
        console.error("MISS", job.id, e);
      }
    }

    // Early collab graph (post-authorize structure) — seek mid-debate then graph tab
    try {
      await director(API, cookieHeader, csrf, cid, "POST", "/seek", {
        chapter_id: "r2_argument",
      });
      await hardReloadConversation(page, base, cid);
      await ensureCollabGraph(page);
      let ui = await probe(page);
      if (ui.reactFlowNodes >= 2) {
        const path = resolve(stillsDir, "09-collab-graph.png");
        await shot(page, path);
        mark({
          id: "09-collab-graph",
          file: "stills/09-collab-graph.png",
          path,
          label: "协作图 · 授权后团队结构",
          usage: "冷开场画面1",
          tape_t_ms: 45_000,
          clean: true,
          matched_text: ui.nodeText.slice(0, 160),
        });
      } else {
        report.notes.push(`09-collab-graph: nodes=${ui.reactFlowNodes}`);
      }
    } catch (e) {
      report.notes.push(`09-collab-graph: ${e.message || e}`);
    }

    // Final collab graph (after verdict / full five rounds)
    try {
      await director(API, cookieHeader, csrf, cid, "POST", "/seek", {
        chapter_id: "verdict",
      });
      await waitStatus(
        API,
        cookieHeader,
        csrf,
        cid,
        (s) => Number(s.t_ms) >= 1100000 || String(s.state).toLowerCase().includes("finish"),
        { timeoutMs: 120_000, label: "verdict for final graph" },
      );
      await hardReloadConversation(page, base, cid);
      await ensureCollabGraph(page);
      await page.waitForTimeout(800);
      const ui = await probe(page);
      if (ui.reactFlowNodes < 2) {
        report.missing.push({
          id: "09b-collab-graph-final",
          reason: `协作图节点不足 nodes=${ui.reactFlowNodes}`,
        });
      } else {
        const path = resolve(stillsDir, "09b-collab-graph-final.png");
        await shot(page, path);
        mark({
          id: "09b-collab-graph-final",
          file: "stills/09b-collab-graph-final.png",
          path,
          label: "协作图终态全貌（四轮打完）",
          usage: "第七幕收尾",
          tape_t_ms: 1118000,
          clean: true,
          new: true,
          matched_text: ui.nodeText.slice(0, 200),
          nodes: ui.reactFlowNodes,
        });
      }
    } catch (e) {
      report.missing.push({
        id: "09b-collab-graph-final",
        reason: String(e.message || e),
      });
    }

    // ── SPEED=1 streaming clip (cold-open alternate) ──
    try {
      await director(API, cookieHeader, csrf, cid, "POST", "/seek", {
        chapter_id: "r1_argument",
      });
      await waitStatus(
        API,
        cookieHeader,
        csrf,
        cid,
        (s) => Number(s.t_ms) >= 50000,
        { timeoutMs: 90_000, label: "seek r1 for speed1 clip" },
      );
      await director(API, cookieHeader, csrf, cid, "POST", "/speed", { speed: 1 });
      await director(API, cookieHeader, csrf, cid, "POST", "/resume", {});
      await hardReloadConversation(page, base, cid);
      await ensureDebateRoom(page);
      // Dense sequence as frame backup
      const seqDir = resolve(sequencesDir, "clip-streaming-debate-speed1");
      await mkdir(seqDir, { recursive: true });
      const seqFiles = [];
      for (let i = 0; i < 12; i++) {
        const p = resolve(seqDir, `frame-${String(i).padStart(2, "0")}.png`);
        await shot(page, p);
        seqFiles.push(p);
        await page.waitForTimeout(900);
      }
      report.sequences.push({
        id: "clip-streaming-debate-speed1",
        dir: seqDir,
        files: seqFiles,
        interval_ms: 900,
        speed: 1,
        usage: "冷开场镜头2 备选 · SPEED=1 双列流式",
        new: true,
      });
      report.notes.push(
        "SPEED=1 streaming: captured 12-frame sequence (~11s). full-session.webm also records this window at end of session.",
      );
    } catch (e) {
      report.missing.push({
        id: "clip-streaming-debate-speed1",
        reason: String(e.message || e),
      });
    }

    const required = [
      "01-user-prompt",
      "02-team-preview",
      "03-debate-opening",
      "08-final-verdict",
    ];
    report.ok =
      required.every((id) => report.assets.some((a) => a.id === id)) &&
      !report.clean_env.has_dev_badge;
  } catch (err) {
    report.fatal = String(err?.stack ?? err);
    await shot(page, resolve(stillsDir, "99-fatal.png")).catch(() => {});
    console.error(report.fatal);
  } finally {
    const vid = page.video();
    await context.close();
    await browser.close();
    await server.close();
    if (vid) {
      try {
        const tmp = await vid.path();
        const dest = resolve(clipsDir, "full-session.webm");
        await copyFile(tmp, dest);
        report.clips.push({
          id: "full-session",
          file: "clips/full-session.webm",
          path: dest,
          label: "整场（含导演 seek / SPEED=1 片段）",
          clean: true,
        });
        // Try ffmpeg cut of last ~12s as speed1 clip if ffmpeg present
        const ff = spawnSync(
          "ffmpeg",
          ["-y", "-sseof", "-12", "-i", dest, "-c", "copy", resolve(clipsDir, "clip-streaming-debate-speed1.webm")],
          { encoding: "utf8" },
        );
        if (ff.status === 0) {
          report.clips.push({
            id: "clip-streaming-debate-speed1",
            file: "clips/clip-streaming-debate-speed1.webm",
            path: resolve(clipsDir, "clip-streaming-debate-speed1.webm"),
            label: "SPEED=1 流式短片（自 full-session 尾部裁 ~12s）",
            usage: "冷开场镜头2 备选",
            speed: 1,
            new: true,
            note: "尾部裁切近似；精确窗口见 sequences/clip-streaming-debate-speed1",
          });
        } else {
          report.notes.push(
            `ffmpeg tail-cut skipped/failed: ${(ff.stderr || ff.error || "").toString().slice(0, 200)}`,
          );
        }
      } catch (e) {
        report.notes.push(`recordVideo: ${e}`);
      }
    }
  }

  report.elapsed_wall_ms = Date.now() - wall0;
  report.conversation_id = cid;

  await writeFile(
    resolve(outRoot, "director-acceptance.json"),
    JSON.stringify(report.director_acceptance, null, 2),
    "utf8",
  );
  await writeFile(
    resolve(outRoot, "manifest.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  const md = buildManifestMd(report);
  await writeFile(resolve(outRoot, "MANIFEST.md"), md, "utf8");

  console.log("\nPROMO_DIRECTOR_CAPTURE", JSON.stringify({
    ok: report.ok,
    assets: report.assets.map((a) => a.id),
    missing: report.missing.map((m) => m.id),
    director: report.director_acceptance.map((d) => `${d.feature}:${d.result}`),
    has_dev_badge: report.clean_env.has_dev_badge,
    fatal: report.fatal,
  }));
  process.exitCode = report.ok ? 0 : 1;
}

function buildManifestMd(report) {
  const lines = [
    "# LV 诉茉莉奶白 · 干净环境宣传素材（导演台驱动）",
    "",
    `| 项 | 值 |`,
    `|---|---|`,
    `| 磁带 | \`demos/tapes/${TAPE}.json\` |`,
    `| 生成时间 | ${report.generated_at} |`,
    `| 方式 | 生产构建 webapp（\`dist-web\` / vite preview）+ 导演控制台 REST + Playwright @ 1920×1080 |`,
    `| 账号 | \`${report.clean_env.user}\`（display_name「演示」· 干净侧栏） |`,
    `| API | ${report.clean_env.api} |`,
    `| DEV 标 | ${report.clean_env.has_dev_badge ? "仍可见（异常）" : "**已去除**（生产构建，未改产品源码）"} |`,
    `| 避开 | 两段结辩 |`,
    "",
    "> 本目录为**干净版**重拍，覆盖旧 DEV 穿帮素材。新增项见下表 \`new\` 列。",
    "",
    "## 环境卫生",
    "",
    `- Webapp：\`${report.clean_env.webapp}\``,
    `- DEV 徽章：${report.clean_env.has_dev_badge ? "可见" : "无"}`,
    `- 账号片段：\`${report.clean_env.account_snippet || ""}\``,
    `- 开拍前侧栏会话数：${report.clean_env.sidebar_conv_count_before ?? "?"}`,
    "",
    "## 静帧（`stills/`）",
    "",
    "| id | 绝对路径 | 镜头 | 干净版 | 新增 | 导演驱动 |",
    "|---|---|---|---|---|---|",
    ...report.assets.map((a) => {
      const abs = a.path || resolve(outRoot, a.file);
      return `| \`${a.id}\` | \`${abs}\` | ${a.label} / ${a.usage ?? ""} | ${a.clean ? "是" : ""} | ${a.new ? "是" : ""} | ${a.director ?? ""} |`;
    }),
    "",
    "### 新增镜头说明",
    "",
    "- `04b-r2-quote-closeup` — R2 金句定点；目标文案：" + QUOTE + "（磁带原文，弯引号）",
    "- `09b-collab-graph-final` — 协作图终态全貌（四轮+终审后），第七幕收尾",
    "- `clip-streaming-debate-speed1` — SPEED=1 原速双列流式 5–15s（冷开场镜头2 备选）",
    "",
    "## 短视频 / 序列",
    "",
    ...report.clips.map((c) => `- **${c.id}**: \`${c.path || c.file}\` — ${c.label}`),
    ...report.sequences.map(
      (s) => `- 序列 **${s.id}**: \`${s.dir}\` (${s.files?.length ?? "?"} 帧) — ${s.usage ?? ""}`,
    ),
    "",
    "## 导演控制台实战验收",
    "",
    "| 功能 | 结果 | 说明 |",
    "|---|---|---|",
    ...report.director_acceptance.map(
      (d) =>
        `| ${d.feature} | ${d.result} | ${(d.detail || "").replace(/\|/g, "/")} |`,
    ),
    "",
    "### 倒带与侧栏刷新",
    "",
    (() => {
      const rw = report.director_acceptance.find((d) => d.feature === "rewind");
      if (!rw) return "- （未测）";
      return rw.needed_sidebar_refresh
        ? "- **确认疑点**：倒带后前端画面未立即对齐，需手动点侧栏/重进会话才恢复。"
        : "- 倒带后前端画面即时对齐，**无需**手动点侧栏刷新。";
    })(),
    "",
    "## 未产出 / 备注",
    "",
    ...(report.missing.length
      ? report.missing.map((m) => `- **${m.id}**: ${m.reason}`)
      : ["- （无缺失）"]),
    ...report.notes.map((n) => `- ${n}`),
    "",
    "## 复现",
    "",
    "```powershell",
    "cd apps/desktop",
    "$env:VITE_API_URL='http://localhost:8015'",
    "pnpm build:webapp",
    "# backend: DEMO_TAPE_REPLAY_ENABLED=true on :8015",
    "$env:PROMO_API='http://localhost:8015'",
    "$env:PROMO_USER='promo_lv'",
    "$env:PROMO_PASS='promopass'",
    "node apps/desktop/scripts/promo_capture_lv_molihua_director.mjs",
    "```",
    "",
  ];
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
