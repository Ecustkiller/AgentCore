/**
 * Capture opening-ready promo stills (+ optional short clips) from a demo tape
 * via real webapp + server replay. Defaults keep the lv-molihua workflow unchanged.
 *
 * Prereq — backend with DEMO_TAPE_REPLAY_ENABLED (dedicated port recommended):
 *   cd apps/server
 *   $env:DEMO_TAPE_REPLAY_ENABLED='true'
 *   $env:DEMO_TAPE_SPEED='12'
 *   $env:DEMO_TAPE_MAX_GAP_MS='800'
 *   uv run uvicorn agentcore.main:app --host 127.0.0.1 --port 8015
 *
 * Run (from repo root or apps/desktop):
 *   $env:PROMO_API='http://localhost:8015'
 *   $env:VITE_API_URL='http://localhost:8015'
 *   node apps/desktop/scripts/promo_capture_lv_molihua.mjs
 *   node apps/desktop/scripts/promo_capture_lv_molihua.mjs --tape <tape-id>
 *   node apps/desktop/scripts/promo_capture_lv_molihua.mjs --tape <id> --out apps/promo/assets/<dir>
 *
 * Env: PROMO_TAPE / PROMO_OUT (same meaning as --tape / --out).
 * Default output → apps/promo/assets/lv-molihua/
 * Does NOT modify product source.
 *
 * Note: SHOT_MARKERS below are content-specific to the molihua debate; a similar
 * single-turn tape can reuse the script, but marker regexes may need editing.
 */

import { access, mkdir, rm, writeFile, copyFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer, preview } from "vite";
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
  console.log(`Usage: node promo_capture_lv_molihua.mjs [--tape <id>] [--out <rel-or-abs>]

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
const SPEED = Number(process.env.PROMO_SPEED ?? 12);
const GAP = Number(process.env.PROMO_GAP ?? 800);
const HEADED = process.env.PROMO_HEADED === "1";
const RECORD_VIDEO = process.env.PROMO_RECORD_VIDEO !== "0";
// Production webapp build removes DEV badge (import.meta.env.DEV=false). No product source change.
const USE_PROD =
  process.env.PROMO_PROD !== "0" &&
  (await access(resolve(distWeb, "index.webapp.html")).then(() => true).catch(() => false));
const VIEWPORT = { width: 1920, height: 1080 };

process.env.VITE_API_URL = API;

/** B 场金句（交锋1 · 公共元素）：与磁带立论原文一致 */
const QUOTE = "任何经营者都不能垄断自然界公共资源的基本表达";

const OPENING_PROMPT =
  "搜索最新的LV起诉茉莉奶白这个案件、简单向我介绍之后启动模拟庭审辩论";

/** UI text markers → promo shot ids. match(text, probe). Prefer 辩论室 view.
 *  File ids kept stable for Remotion/manifest continuity; labels follow B-field storyboard. */
const SHOT_MARKERS = [
  {
    id: "03-debate-opening",
    label: "辩论开场：双方与辩题（显著性）",
    match: (t, p) =>
      (!p.roundNo || Number(p.roundNo) === 1) &&
      /正方|原告/.test(t) &&
      /反方|被告/.test(t) &&
      /立论|辩题|四叶花卉|主持人|显著性/.test(t),
    preferDebateRoom: true,
    tapeHint: "debate_round_started r1 @ t_ms≈164533 (post-authorize)",
  },
  {
    id: "04-r2-diamond-square",
    label: "交锋1 · 公共元素 vs 获得显著性",
    match: (t, p) =>
      Number(p.roundNo) >= 1 &&
      (/垄断自然界公共资源|固有显著性|获得显著性|唯一关联|第二含义/.test(t)),
    preferDebateRoom: true,
    tapeHint: "r1 focus 商标显著性 @ t_ms≈164533–563065",
  },
  {
    id: "05-r3-logo-swap",
    label: "交锋2 · 跨类标准与真实使用",
    match: (t, p) =>
      Number(p.roundNo) >= 2 &&
      (/跨类|第43类|真实商业使用|防御注册|茶饮消费者|认知链断裂/.test(t)),
    preferDebateRoom: true,
    tapeHint: "r2 focus 跨类保护 @ t_ms≈563065–861441",
  },
  {
    id: "05b-r4-logo-defense",
    label: "交锋3 · 无茶饮消费者混淆调查",
    match: (t, p) =>
      Number(p.roundNo) >= 3 &&
      (/消费者调查|茶饮消费者.*联想|反稀释|相当程度的联系|实证门槛/.test(t)),
    preferDebateRoom: true,
    tapeHint: "r3 focus 跨类边界 @ t_ms≈861441–1130562",
  },
  {
    id: "06-r5-burden",
    label: "交锋3 决胜 · R4 再钉实证门槛",
    match: (t, p) =>
      Number(p.roundNo) >= 4 &&
      (/确实无法提供茶饮消费者|实证调查|反稀释|实际使用前提|罚分/.test(t)),
    preferDebateRoom: true,
    tapeHint: "r4 debate_round @ t_ms≈1130562–1309596",
  },
  {
    id: "07-evidence-gap-admit",
    label: "质询高光 · LV 承认无消费者调查",
    match: (t) =>
      /我承认没有消费者调查|没有消费者调查数据支撑|确实无法提供茶饮消费者/.test(t),
    preferDebateRoom: true,
    tapeHint: "r3/r4 cross-exam admit @ t_ms≈1130562+",
  },
  {
    id: "08-final-verdict",
    label: "最终裁决（微弱倾向茉莉奶白 · 55%）",
    match: (t) =>
      (/微弱倾向茉莉奶白|倾向茉莉奶白/.test(t)) &&
      (/55\s*%|中等偏低|置信度|符号独占|需要你定夺|定夺/.test(t)),
    preferDebateRoom: true,
    tapeHint: "debate_result @ t_ms≈1330177",
  },
];
const CLIP_MARKERS = [
  {
    id: "clip-streaming-debate",
    label: "流式打字中的辩论发言",
    startWhen: (t, p) =>
      p.streaming && /立论|论点|原告方|被告方/.test(t) && !/协作图/.test(t.slice(0, 80)),
    durationMs: 12_000,
    tapeHint: "any mid-debate streaming window",
  },
  {
    id: "clip-round-advance",
    label: "比分/轮次推进",
    startWhen: (t) =>
      /第\s*[2-5]\s*轮|第[2-5]轮/.test(t) ||
      (/已收敛/.test(t) && /轮/.test(t)),
    durationMs: 10_000,
    tapeHint: "round transition / scoreboard",
  },
];

async function dismissOnboarding(page) {
  const dialog = page.locator('[aria-label="欢迎使用 AgentCore"]');
  if (!(await dialog.isVisible().catch(() => false))) return;
  const skip = dialog.getByRole("button", { name: /^跳过$/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function ensureDebateRoom(page) {
  const debateTab = page.getByRole("button", { name: /^辩论室$/ });
  if (await debateTab.isVisible().catch(() => false)) {
    await debateTab.click();
    await page.waitForTimeout(600);
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
    await page.waitForTimeout(1000);
    return true;
  }
  return false;
}

function nowIso() {
  return new Date().toISOString();
}

async function probe(page) {
  return page.evaluate(() => {
    // Exclude sidebar history — prior chats contain the same case keywords and
    // caused false-positive marker hits (菱形/举证/换标 from unrelated sessions).
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
    return {
      text,
      textLen: text.length,
      snippet: text.slice(0, 900),
      streaming: /停止生成/.test(full),
      authorize: /授权开赛|授权并开工/.test(full),
      waitKickoff: /等待开工确认|开工卡/.test(full),
      caseBrief: /案情简介|一审判决|1030/.test(text),
      debate: /主持人|立论|辩题|交叉|质询|结辩/.test(text),
      reactFlow: document.querySelectorAll(".react-flow").length,
      reactFlowNodes: document.querySelectorAll(".react-flow__node").length,
      nodeText: nodeText.slice(0, 600),
      openDebate: /打开辩论室/.test(full),
      verdict:
        (/微弱倾向茉莉奶白|倾向茉莉奶白/.test(text)) &&
        /55\s*%|中等偏低|置信度|符号独占|定夺/.test(text),
      hasDevBadge: /\bDEV\b/.test(full.slice(0, 500)),
      hasQuote:
        text.includes("垄断自然界公共资源") ||
        text.includes("任何经营者都不能垄断"),
      quoteContext:
        text.match(/.{0,24}垄断自然界公共资源.{0,40}/)?.[0] ??
        text.match(/.{0,20}任何经营者都不能垄断.{0,40}/)?.[0] ??
        null,
      // UI often keeps「第1轮」chip visible; take the highest round mentioned.
      roundNo: (() => {
        const nums = [...text.matchAll(/第\s*([1-5])\s*轮/g)].map((m) =>
          Number(m[1]),
        );
        return nums.length ? String(Math.max(...nums)) : null;
      })(),
    };
  });
}

/** Default: skip overwrite of existing stills. PROMO_OVERWRITE=1|all|id,id */
function mayOverwriteStill(id) {
  const raw = (process.env.PROMO_OVERWRITE || "").trim();
  if (!raw) return false;
  if (raw === "1" || raw.toLowerCase() === "all") return true;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)).has(id);
}

async function shot(page, absPath, { id, force = false } = {}) {
  const stillId = id || absPath.replace(/.*[/\\]/, "").replace(/\.png$/i, "");
  if (!force && !mayOverwriteStill(stillId)) {
    try {
      await access(absPath);
      console.log("SKIP existing still (set PROMO_OVERWRITE to replace)", stillId);
      return { path: absPath, skipped: true };
    } catch {
      /* write new */
    }
  }
  await page.screenshot({
    path: absPath,
    fullPage: false,
    type: "png",
  });
  return { path: absPath, skipped: false };
}

async function denseSequence(page, dir, prefix, count, intervalMs) {
  await mkdir(dir, { recursive: true });
  const paths = [];
  for (let i = 0; i < count; i++) {
    const path = resolve(dir, `${prefix}-${String(i).padStart(2, "0")}.png`);
    await shot(page, path);
    paths.push(path);
    if (i < count - 1) await page.waitForTimeout(intervalMs);
  }
  return paths;
}

async function main() {
  process.chdir(desktopDir);
  // Preserve director acceptance report across wipe.
  let priorDirector = null;
  try {
    priorDirector = JSON.parse(
      await readFile(resolve(outRoot, "director-acceptance.json"), "utf8"),
    );
  } catch {
    /* none */
  }
  // Default: do NOT wipe the asset tree. Opt-in: PROMO_WIPE=1
  if (process.env.PROMO_WIPE === "1") {
    await rm(outRoot, { recursive: true, force: true });
  }
  await mkdir(stillsDir, { recursive: true });
  await mkdir(clipsDir, { recursive: true });
  await mkdir(sequencesDir, { recursive: true });
  if (RECORD_VIDEO) await mkdir(videoTmpDir, { recursive: true });
  if (priorDirector) {
    await writeFile(
      resolve(outRoot, "director-acceptance.json"),
      JSON.stringify(priorDirector, null, 2),
      "utf8",
    );
  }

  const manifest = {
    generated_at: nowIso(),
    tape: TAPE,
    tape_path: `demos/tapes/${TAPE}.json`,
    video_plan:
      TAPE === DEFAULT_TAPE ? "demos/video-plan-lv-molihua.md" : null,
    method: USE_PROD
      ? "server demo-tape replay + Playwright production webapp (dist-web / vite preview) @ 1920×1080 — clean, no DEV badge"
      : "server demo-tape replay + Playwright vite.webapp DEV @ 1920×1080",
    clean_env: {
      production_webapp: USE_PROD,
      user: USER,
      display_name: "演示",
      no_product_source_change: true,
    },
    director_acceptance: priorDirector,
    api: API,
    speed: SPEED,
    max_gap_ms: GAP,
    viewport: VIEWPORT,
    opening_prompt: OPENING_PROMPT,
    assets: [],
    clips: [],
    sequences: [],
    missing: [],
    notes: [],
    ok: false,
  };

  const server = USE_PROD
    ? await preview({
        configFile: resolve(desktopDir, "vite.webapp.config.ts"),
        preview: { port: PORT, strictPort: true },
      })
    : await createServer({
        configFile: resolve(desktopDir, "vite.webapp.config.ts"),
        logLevel: "warn",
        server: { port: PORT, strictPort: true },
      });
  if (!USE_PROD) await server.listen();
  const base = server.resolvedUrls?.local?.[0];
  if (!base) {
    await server.close();
    throw new Error("Vite did not report a local URL.");
  }
  console.log(
    `${USE_PROD ? "prod" : "dev"} webapp ${base} → api ${API} (speed=${SPEED} gap=${GAP})`,
  );

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "zh-CN",
    recordVideo: RECORD_VIDEO
      ? { dir: videoTmpDir, size: VIEWPORT }
      : undefined,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => {
    manifest.notes.push(`pageerror: ${e.message}`);
  });

  let csrf = null;
  page.on("response", (r) => {
    const t = r.headers()["x-csrf-token"];
    if (t) csrf = t;
  });

  const captured = new Set();
  const clipStarted = new Set();
  let wall0 = Date.now();
  let videoPath = null;

  const markAsset = (entry) => {
    manifest.assets.push(entry);
    console.log("SHOT", entry.id, entry.path);
  };

  try {
    // Health: demo-tape catalog must not 404
    const health = await fetch(`${API}/readyz`).catch(() => null);
    if (!health?.ok) {
      throw new Error(
        `Backend not ready at ${API}/readyz — start uvicorn with DEMO_TAPE_REPLAY_ENABLED=true`,
      );
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
    await dismissOnboarding(page);

    // Clean sidebar: delete prior conversations for this promo account.
    {
      const cookies0 = await context.cookies(API);
      const ch0 = cookies0.map((c) => `${c.name}=${c.value}`).join("; ");
      const lst = await fetch(`${API}/v1/conversations?limit=100`, {
        headers: {
          "Content-Type": "application/json",
          Cookie: ch0,
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
      });
      if (lst.ok) {
        const items = (await lst.json()).data || [];
        for (const it of items) {
          await fetch(`${API}/v1/conversations/${it.id}`, {
            method: "DELETE",
            headers: {
              Cookie: ch0,
              ...(csrf ? { "X-CSRF-Token": csrf } : {}),
            },
          });
        }
        manifest.notes.push(`cleaned ${items.length} prior conversations`);
        await page.reload({ waitUntil: "load" });
        await dismissOnboarding(page);
        await composer.waitFor({ state: "visible", timeout: 20_000 });
      }
    }

    const hygiene = await probe(page);
    manifest.clean_env.has_dev_badge = hygiene.hasDevBadge;
    if (hygiene.hasDevBadge) {
      manifest.notes.push("WARN: DEV badge still visible");
    } else {
      manifest.notes.push("DEV badge absent (production build)");
    }

    const cookies = await context.cookies(API);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const prepRes = await fetch(`${API}/v1/demo-tape/prepare`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: JSON.stringify({
        tape_id: TAPE,
        speed: SPEED,
        max_gap_ms: GAP,
      }),
    });
    if (!prepRes.ok) {
      throw new Error(
        `prepare failed ${prepRes.status}: ${await prepRes.text()}`,
      );
    }
    const prep = await prepRes.json();
    const cid = prep.conversation_id;
    const prompt = prep.user_prompt || OPENING_PROMPT;
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
    await page.waitForTimeout(600);

    // 1) User typing opening prompt
    await composer.click({ force: true });
    await composer.fill("");
    // Type with a slight delay so the composer shot looks natural
    await composer.pressSequentially(prompt, { delay: 8 });
    await page.waitForTimeout(400);
    const p01 = resolve(stillsDir, "01-user-prompt.png");
    await shot(page, p01);
    markAsset({
      id: "01-user-prompt",
      file: "stills/01-user-prompt.png",
      path: p01,
      label: "用户输入开场 prompt",
      shot: "第二幕 · 一句话发起",
      tape_t_ms: 0,
      usage: "冷开场前 / 第二幕：展示「只打了这么一句话」",
      matched_text: prompt.slice(0, 80),
    });
    captured.add("01-user-prompt");

    wall0 = Date.now();
    await composer.press("Enter");
    console.log("sent; polling…");

    // 2) Team preview / authorize
    let authorizeAt = null;
    for (let i = 0; i < 180; i++) {
      const p = await probe(page);
      if (
        (p.authorize || p.waitKickoff) &&
        !captured.has("02-team-preview")
      ) {
        const path = resolve(stillsDir, "02-team-preview.png");
        await shot(page, path);
        markAsset({
          id: "02-team-preview",
          file: "stills/02-team-preview.png",
          path,
          label: "captain 组建辩论团队 / 开工卡",
          shot: "第四幕 · 组队 + 授权",
          tape_t_ms: 32_000,
          usage: "冷开场 / 第四幕：team_preview 双方立场",
          matched_text: p.snippet.slice(0, 120),
        });
        captured.add("02-team-preview");
        authorizeAt = Date.now();
        break;
      }
      await page.waitForTimeout(400);
    }
    if (!captured.has("02-team-preview")) {
      manifest.missing.push({
        id: "02-team-preview",
        reason: "授权开赛 / 开工卡未在超时内出现",
      });
    }

    // Optional: delegating mid-state before authorize (if still visible earlier — already past)
    // Resume
    const authBtn = page.getByRole("button", {
      name: /授权开赛|授权并开工|开做/,
    });
    if (await authBtn.first().isVisible().catch(() => false)) {
      await authBtn.first().click();
      console.log("clicked 授权开赛");
      await page.waitForTimeout(800);
    } else if (authorizeAt) {
      const cont = page.getByRole("button", { name: /^继续$/ });
      if (await cont.isVisible().catch(() => false)) await cont.click();
    }

    // Main poll loop until verdict or timeout
    const deadline = Date.now() + 15 * 60_000; // 15 min wall budget
    let graphShot = false;
    let debateRoomOpened = false;
    let lastTextLen = 0;
    let stagnantSince = null;
    let lastRoundLog = null;

    while (Date.now() < deadline) {
      // Stay in 辩论室 for content markers (graph view hides argument text)
      if (!debateRoomOpened) {
        const openBtn = page.getByRole("button", { name: /打开辩论室/ });
        if (await openBtn.first().isVisible().catch(() => false)) {
          await openBtn.first().click();
          debateRoomOpened = true;
          await page.waitForTimeout(1500);
        } else if (
          await page.getByRole("button", { name: /^辩论室$/ }).isVisible().catch(() => false)
        ) {
          debateRoomOpened = true;
        }
      } else {
        await ensureDebateRoom(page);
      }

      const p = await probe(page);
      const t = p.text;

      // Collaboration graph still (then immediately return to 辩论室)
      if (!graphShot && (p.reactFlowNodes >= 3 || debateRoomOpened)) {
        const switched = await ensureCollabGraph(page);
        await page.waitForTimeout(800);
        const pg = await probe(page);
        if (pg.reactFlow > 0 && pg.reactFlowNodes >= 2) {
          const path = resolve(stillsDir, "09-collab-graph.png");
          await shot(page, path);
          markAsset({
            id: "09-collab-graph",
            file: "stills/09-collab-graph.png",
            path,
            label: "协作图 / 团队结构可视化",
            shot: "冷开场画面1 / 第七幕回看",
            tape_t_ms: 45_000,
            usage: "冷开场快闪；收尾拉远",
            matched_text: pg.nodeText.slice(0, 160),
          });
          captured.add("09-collab-graph");
          graphShot = true;
        }
        if (switched || graphShot) {
          await ensureDebateRoom(page);
        }
      }

      for (const m of SHOT_MARKERS) {
        if (captured.has(m.id)) continue;
        if (!m.match(t, p)) continue;
        if (m.preferDebateRoom) await ensureDebateRoom(page);
        const path = resolve(stillsDir, `${m.id}.png`);
        await shot(page, path);
        markAsset({
          id: m.id,
          file: `stills/${m.id}.png`,
          path,
          label: m.label,
          shot: m.label,
          tape_hint: m.tapeHint,
          usage: "第五幕精剪 / 冷开场",
          clean: true,
          matched_text:
            t.match(
              /.{0,40}(?:垄断自然界|获得显著性|唯一关联|跨类|第43类|消费者调查|微弱倾向|辩题|置信度|防御注册).{0,40}/,
            )?.[0] ?? t.slice(0, 100),
          wall_ms: Date.now() - wall0,
        });
        captured.add(m.id);
      }

      // 交锋1 金句特写（独立轮询——勿绑在 04 首次命中上，否则易早拍错过金句）
      if (
        !captured.has("04b-r2-quote-closeup") &&
        (p.hasQuote || /垄断自然界公共资源的基本表达/.test(t))
      ) {
        await ensureDebateRoom(page);
        const qp = resolve(stillsDir, "04b-r2-quote-closeup.png");
        await shot(page, qp);
        markAsset({
          id: "04b-r2-quote-closeup",
          file: "stills/04b-r2-quote-closeup.png",
          path: qp,
          label: "交锋1 金句定点特写",
          usage: `交锋1 金句；须可见「${QUOTE}」`,
          clean: true,
          new: true,
          quote_required: QUOTE,
          quote_visible: true,
          matched_text: p.quoteContext || QUOTE,
        });
        captured.add("04b-r2-quote-closeup");
      }

      // Dense still sequences (pause polling so frames stay coherent)
      for (const c of CLIP_MARKERS) {
        if (clipStarted.has(c.id)) continue;
        if (!c.startWhen(t, p)) continue;
        clipStarted.add(c.id);
        await ensureDebateRoom(page);
        const seqDir = resolve(sequencesDir, c.id);
        console.log("CLIP/SEQ start", c.id);
        const paths = await denseSequence(
          page,
          seqDir,
          c.id,
          Math.max(6, Math.round(c.durationMs / 900)),
          900,
        );
        const rel = (abs) =>
          abs.replace(outRoot + "\\", "").replace(outRoot + "/", "");
        manifest.sequences.push({
          id: c.id,
          label: c.label,
          dir: seqDir,
          files: paths.map(rel),
          interval_ms: 900,
          usage: "短视频片段的密集截图替代（可补帧/剪辑）",
          tape_hint: c.tapeHint,
        });
      }

      if (captured.has("08-final-verdict") && graphShot) {
        await page.waitForTimeout(1200);
        break;
      }
      // Progress = main-pane text growth. Do NOT use「停止生成」alone — debate
      // room often hides the composer stop control between agent turns.
      if (p.textLen > lastTextLen + 40) {
        lastTextLen = p.textLen;
        stagnantSince = null;
      } else if (Date.now() - wall0 > 90_000) {
        if (!stagnantSince) stagnantSince = Date.now();
        if (
          Date.now() - stagnantSince > 45_000 &&
          (captured.has("08-final-verdict") || p.verdict)
        ) {
          console.log("content stagnant after verdict; stopping", {
            captured: [...captured],
          });
          break;
        }
        if (
          Date.now() - stagnantSince > 120_000 &&
          !p.streaming &&
          captured.has("02-team-preview")
        ) {
          console.log("content stagnant 120s; stopping", {
            captured: [...captured],
            textLen: p.textLen,
          });
          break;
        }
      }

      if (p.roundNo && p.roundNo !== lastRoundLog) {
        lastRoundLog = p.roundNo;
        console.log("round→", p.roundNo, "textLen", p.textLen, "captured", [
          ...captured,
        ]);
      }

      await page.waitForTimeout(450);
    }

    // Final wrap still if verdict missed mid-stream but text present
    if (!captured.has("08-final-verdict")) {
      const p = await probe(page);
      if (/微弱倾向茉莉奶白|倾向茉莉奶白/.test(p.text) && /55\s*%|中等偏低|置信|定夺|符号独占/.test(p.text)) {
        const path = resolve(stillsDir, "08-final-verdict.png");
        await shot(page, path);
        markAsset({
          id: "08-final-verdict",
          file: "stills/08-final-verdict.png",
          path,
          label: "最终裁决（微弱倾向茉莉奶白 · 55%）",
          shot: "第六幕 · 裁决出炉",
          tape_hint: "debate_result @ t_ms≈1330177",
          usage: "冷开场画面4 / 第六幕特写",
          matched_text: p.snippet.slice(0, 160),
        });
        captured.add("08-final-verdict");
      }
    }

    // Graph retry at end + final-state graph (第七幕)
    {
      const cta = page.getByRole("button", { name: /打开辩论室|在画布打开|协作图/ });
      if (await cta.first().isVisible().catch(() => false)) {
        await cta.first().click();
        await page.waitForTimeout(1500);
      }
      await ensureCollabGraph(page);
      const p = await probe(page);
      if (p.reactFlow > 0 && p.reactFlowNodes >= 2) {
        if (!graphShot) {
          const path = resolve(stillsDir, "09-collab-graph.png");
          await shot(page, path);
          markAsset({
            id: "09-collab-graph",
            file: "stills/09-collab-graph.png",
            path,
            label: "协作图 / 团队结构可视化",
            shot: "冷开场 / 第七幕",
            tape_t_ms: null,
            usage: "冷开场快闪",
            clean: true,
            matched_text: p.nodeText.slice(0, 160),
          });
          captured.add("09-collab-graph");
          graphShot = true;
        }
        // Always shoot final graph after verdict if available
        if (captured.has("08-final-verdict") || p.verdict) {
          const path = resolve(stillsDir, "09b-collab-graph-final.png");
          await shot(page, path);
          markAsset({
            id: "09b-collab-graph-final",
            file: "stills/09b-collab-graph-final.png",
            path,
            label: "协作图终态全貌（四轮打完）",
            usage: "第七幕收尾",
            clean: true,
            new: true,
            matched_text: p.nodeText.slice(0, 200),
            nodes: p.reactFlowNodes,
          });
          captured.add("09b-collab-graph-final");
        }
      }
    }

    if (
      captured.has("04-r2-diamond-square") &&
      !captured.has("04b-r2-quote-closeup")
    ) {
      manifest.missing.push({
        id: "04b-r2-quote-closeup",
        reason: `R2 已截但画面未检出完整金句「${QUOTE}」`,
      });
    }

    for (const m of SHOT_MARKERS) {
      if (!captured.has(m.id)) {
        manifest.missing.push({
          id: m.id,
          label: m.label,
          reason: `回放过程中未匹配到 UI 文本（tape_hint: ${m.tapeHint}）`,
        });
      }
    }
    if (!captured.has("09-collab-graph")) {
      manifest.missing.push({
        id: "09-collab-graph",
        reason: "协作图 react-flow 未出现",
      });
    }

    manifest.ok =
      captured.has("01-user-prompt") &&
      captured.has("02-team-preview") &&
      captured.has("08-final-verdict");
  } catch (err) {
    manifest.fatal = String(err?.stack ?? err);
    const fatalPath = resolve(stillsDir, "99-fatal.png");
    await shot(page, fatalPath).catch(() => {});
    console.error(manifest.fatal);
  } finally {
    // Persist Playwright video if any
    const vid = page.video();
    await context.close();
    await browser.close();
    await server.close();
    if (vid && RECORD_VIDEO) {
      try {
        const tmp = await vid.path();
        const dest = resolve(clipsDir, "full-session.webm");
        await copyFile(tmp, dest);
        videoPath = dest;
        manifest.clips.push({
          id: "full-session",
          file: "clips/full-session.webm",
          path: dest,
          label: "整场回放（Playwright recordVideo）",
          usage: "可按 wall 时间码剪「流式发言」「轮次推进」5–15s；未自动切片（需本机 ffmpeg）",
          note: "整段录制；短片段请按 manifest.assets[].wall_ms 裁切",
        });
        manifest.notes.push(
          "短视频：已产出 full-session.webm；未做自动裁切。若需 5–15s 片段，用 ffmpeg 按 assets 的 wall_ms 裁切，或使用 sequences/ 密集帧。",
        );
      } catch (e) {
        manifest.notes.push(`recordVideo failed: ${e}`);
        manifest.notes.push(
          "短视频不可用 → 已用 sequences/ 密集截图序列替代（见 manifest.sequences）",
        );
      }
    } else if (!RECORD_VIDEO) {
      manifest.notes.push("PROMO_RECORD_VIDEO=0；仅截图 + sequences");
    }
  }

  manifest.captured_ids = [...captured];
  manifest.elapsed_wall_ms = Date.now() - wall0;
  if (videoPath) manifest.full_video = videoPath;

  const manifestPath = resolve(outRoot, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const dirAcc = Array.isArray(manifest.director_acceptance)
    ? manifest.director_acceptance
    : [];
  const md = [
    "# LV 诉茉莉奶白 · 干净环境宣传素材",
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 磁带 | \`${manifest.tape_path}\` |`,
    `| 生成时间 | ${manifest.generated_at} |`,
    `| 方式 | ${manifest.method} |`,
    `| 账号 | \`${USER}\`（display_name「演示」） |`,
    `| DEV 标 | ${manifest.clean_env?.has_dev_badge ? "仍可见" : "**已去除**（生产构建 dist-web，未改产品源码）"} |`,
    `| 回放 | speed=${SPEED}, max_gap_ms=${GAP} |`,
    `| 视口 | ${VIEWPORT.width}×${VIEWPORT.height} |`,
    `| 验收 ok | ${manifest.ok} |`,
    "",
    "> 本目录为**干净版**重拍。导演控制台实战验收见下文 / `director-acceptance.json`。",
    "",
    "## 静帧（绝对路径）",
    "",
    "| id | 绝对路径 | 镜头 | 干净版 | 新增 |",
    "|---|---|---|---|---|",
    ...manifest.assets.map((a) => {
      const abs = a.path || resolve(outRoot, a.file);
      return `| \`${a.id}\` | \`${abs}\` | ${a.label} / ${a.usage ?? ""} | ${a.clean ? "是" : ""} | ${a.new ? "是" : ""} |`;
    }),
    "",
    "### 新增镜头",
    "",
    `- \`04b-r2-quote-closeup\` — R2 金句定点；目标文案：${QUOTE}`,
    "- `09b-collab-graph-final` — 协作图终态全貌（四轮后），第七幕收尾",
    "- `clip-streaming-debate-speed1` — 见导演台脚本另拍 / sequences（SPEED=1）",
    "",
    "## 短视频 / 序列",
    "",
    ...(manifest.clips.length
      ? manifest.clips.map((c) => `- **${c.id}**: \`${c.path || resolve(outRoot, c.file)}\` — ${c.label}`)
      : ["- （见 sequences 或 full-session.webm）"]),
    ...manifest.sequences.map(
      (s) => `- 序列 **${s.id}**: \`${s.dir}\` (${s.files?.length ?? "?"} 帧)`,
    ),
    "",
    "## 导演控制台实战验收",
    "",
    ...(dirAcc.length
      ? [
          "| 功能 | 结果 | 说明 |",
          "|---|---|---|",
          ...dirAcc.map(
            (d) =>
              `| ${d.feature} | ${d.result} | ${(d.detail || "").replace(/\|/g, "/")} |`,
          ),
          "",
          (() => {
            const rw = dirAcc.find((d) => d.feature === "rewind");
            if (!rw) return "";
            return rw.needed_sidebar_refresh
              ? "- **倒带疑点确认**：倒带后前端未即时对齐，需硬刷新/点侧栏会话。\n"
              : "- 倒带后前端即时对齐（本轮未复现「必须点侧栏」）。\n";
          })(),
        ]
      : [
          "- 详见 `apps/desktop/scripts/promo_capture_lv_molihua_director.mjs` 与 `director-acceptance.json`。",
          "",
        ]),
    "## 未产出 / 备注",
    "",
    ...(manifest.missing.length
      ? manifest.missing.map((m) => `- **${m.id}**: ${m.reason}`)
      : ["- （无缺失）"]),
    ...manifest.notes.map((n) => `- ${n}`),
    "",
    "## 避开",
    "",
    "- 两段结辩（closing）画面故意不采。",
    "",
    "## 复现",
    "",
    "```powershell",
    "cd apps/desktop",
    "$env:VITE_API_URL='http://localhost:8015'",
    "pnpm build:webapp   # 去 DEV 标",
    "# backend DEMO_TAPE_REPLAY_ENABLED on :8015（含导演台路由）",
    "$env:PROMO_API='http://localhost:8015'",
    "$env:PROMO_USER='promo_lv'; $env:PROMO_PASS='promopass'",
    "node apps/desktop/scripts/promo_capture_lv_molihua_director.mjs  # 导演验收",
    "node apps/desktop/scripts/promo_capture_lv_molihua.mjs           # 干净静帧（直播回放）",
    "```",
    "",
  ].join("\n");
  await writeFile(resolve(outRoot, "MANIFEST.md"), md, "utf8");

  console.log("\nMANIFEST", manifestPath);
  console.log(
    "PROMO_CAPTURE",
    JSON.stringify({
      ok: manifest.ok,
      captured: manifest.captured_ids,
      missing: manifest.missing.map((m) => m.id),
      clips: manifest.clips.map((c) => c.id),
      fatal: manifest.fatal,
    }),
  );
  process.exitCode = manifest.ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
