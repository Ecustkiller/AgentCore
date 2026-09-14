/**
 * full — director-driven promo capture for any demo tape.
 *
 * Invoked via: node scripts/promo_capture.mjs full --tape <id> [--out]
 *
 * Structural stills (best-effort): user-prompt, team-preview, debate-opening,
 * collab-graph. Plus one still per director chapter id.
 */

import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { preview } from "vite";
import { desktopDir, distWeb, resolveCapturePaths, loadCreds } from "../shared/paths.mjs";
import { authHeaders, director } from "../shared/director.mjs";
import {
  dismissOnboarding,
  ensureDebateRoom,
  ensureCollabGraph,
  clickAuthorize,
  captureProbe,
  waitUi,
  landAfterSeek,
} from "../shared/ui.mjs";

const VIEWPORT = { width: 1920, height: 1080 };

let TAPE;
let outRoot;
let stillsDir;
let USER;
let PASS;
let API;
let PORT;
let CAPTURE_SPEED;
let GAP;
let HEADED;

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

function mayOverwriteStill(id) {
  const raw = (process.env.PROMO_OVERWRITE || "").trim();
  if (!raw) return false;
  if (raw === "1" || raw.toLowerCase() === "all") return true;
  const allow = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return allow.has(id);
}

async function shot(page, absPath, { id, force = false } = {}) {
  const stillId = id || absPath.replace(/.*[/\\]/, "").replace(/\.png$/i, "");
  if (!force && !mayOverwriteStill(stillId)) {
    try {
      await access(absPath);
      console.log("SKIP existing still (set PROMO_OVERWRITE to replace)", stillId);
      return { path: absPath, skipped: true };
    } catch {
      /* not present — write */
    }
  }
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      await page.screenshot({ path: absPath, fullPage: false, type: "png" });
      return { path: absPath, skipped: false };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

function slug(id) {
  return String(id || "chapter")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function markStill(page, report, { id, label, file }) {
  const path = resolve(stillsDir, file);
  const wrote = await shot(page, path, { id });
  if (!wrote.skipped) {
    const entry = { id, file: `stills/${file}`, path, label };
    report.assets.push(entry);
    console.log("SHOT", id, path);
  }
}

async function main() {
  process.chdir(desktopDir);

  if (!(await exists(resolve(distWeb, "index.webapp.html")))) {
    throw new Error(
      `Missing ${distWeb}/index.webapp.html — run: $env:VITE_API_URL='${API}'; pnpm build:webapp`,
    );
  }

  if (process.env.PROMO_WIPE === "1") {
    await rm(outRoot, { recursive: true, force: true });
  }
  await mkdir(stillsDir, { recursive: true });

  const report = {
    generated_at: nowIso(),
    tape: TAPE,
    director_acceptance: [],
    assets: [],
    missing: [],
    notes: [],
    ok: false,
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
  console.log(`prod webapp ${base} → api ${API} tape=${TAPE}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "zh-CN",
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

  try {
    const health = await fetch(`${API}/readyz`).catch(() => null);
    if (!health?.ok) {
      throw new Error(`Backend not ready at ${API}/readyz`);
    }

    await page.goto(new URL("index.webapp.html", base).href, {
      waitUntil: "load",
      timeout: 30_000,
    });
    const userBox = page.getByPlaceholder("邮箱或用户名");
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
    try {
      await composer.waitFor({ state: "visible", timeout: 30_000 });
    } catch (e) {
      const bodyText = await page
        .evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 300))
        .catch(() => "");
      if (/无法连接后端|服务暂时不可用/.test(bodyText)) {
        throw new Error(
          `Webapp cannot reach backend (CORS origin / API-host mismatch). ` +
            `Use the same host for PROMO_API and VITE_API_URL (localhost, not 127.0.0.1). Page: ${bodyText}`,
        );
      }
      throw e;
    }
    await dismissOnboarding(page);

    const cookies = await context.cookies(API);
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

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

    const hygiene = await captureProbe(page);
    if (hygiene.hasDevBadge) {
      report.notes.push("WARN: DEV badge visible in production build");
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
    const prompt = prep.user_prompt || "";
    console.log("prepared", cid);

    await page.goto(new URL(`index.webapp.html#/conversations/${cid}`, base).href, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await page.reload({ waitUntil: "load", timeout: 30_000 });
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    await dismissOnboarding(page);
    await page
      .locator('[data-composer-dock="center"]')
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .catch(() => {});
    await page.waitForTimeout(500);

    await composer.click({ force: true });
    await composer.fill("");
    if (prompt) await composer.pressSequentially(prompt, { delay: 6 });
    await page.waitForTimeout(300);
    await markStill(page, report, {
      id: "user-prompt",
      file: "user-prompt.png",
      label: "开场输入",
    });

    await composer.press("Enter");
    console.log("sent; waiting kickoff…");

    try {
      await waitUi(page, (p) => p.authorize || p.waitKickoff, {
        timeoutMs: 120_000,
        label: "team_preview card",
      });
      await markStill(page, report, {
        id: "team-preview",
        file: "team-preview.png",
        label: "开工卡",
      });
    } catch (e) {
      report.missing.push({ id: "team-preview", reason: String(e.message || e) });
    }

    await clickAuthorize(page);

    for (let i = 0; i < 40; i++) {
      await ensureDebateRoom(page);
      const p = await captureProbe(page);
      if (p.debate) break;
      await page.waitForTimeout(500);
    }
    {
      const ui = await captureProbe(page);
      if (ui.debate) {
        await markStill(page, report, {
          id: "debate-opening",
          file: "debate-opening.png",
          label: "辩论室开场",
        });
      }
    }

    if (await ensureCollabGraph(page)) {
      const g = await captureProbe(page);
      if (g.reactFlow > 0) {
        await markStill(page, report, {
          id: "collab-graph",
          file: "collab-graph.png",
          label: "协作图",
        });
      }
    }

    try {
      await director(API, cookieHeader, csrf, cid, "POST", "/resume", {});
      await director(API, cookieHeader, csrf, cid, "POST", "/speed", { speed: 4 });
      const before = await director(API, cookieHeader, csrf, cid, "GET", "/status");
      await director(API, cookieHeader, csrf, cid, "POST", "/pause", {});
      const after = await director(API, cookieHeader, csrf, cid, "GET", "/status");
      noteDir({
        feature: "pause",
        result: String(after.state).toLowerCase().includes("pause") ? "pass" : "fail",
        detail: `before=${before.state} after=${after.state}`,
      });
      await director(API, cookieHeader, csrf, cid, "POST", "/speed", { speed: 2 });
      let s = await director(API, cookieHeader, csrf, cid, "GET", "/status");
      const ok2 = Number(s.speed) === 2;
      await director(API, cookieHeader, csrf, cid, "POST", "/speed", { speed: 8 });
      s = await director(API, cookieHeader, csrf, cid, "GET", "/status");
      noteDir({
        feature: "speed",
        result: ok2 && Number(s.speed) === 8 ? "pass" : "partial",
        detail: `set 2→${ok2}; speed=${s.speed}`,
      });
      await director(API, cookieHeader, csrf, cid, "POST", "/resume", {});
      s = await director(API, cookieHeader, csrf, cid, "GET", "/status");
      noteDir({
        feature: "resume",
        result: String(s.state).toLowerCase().includes("pause") ? "fail" : "pass",
        detail: `state=${s.state}`,
      });
    } catch (e) {
      noteDir({ feature: "transport", result: "fail", detail: String(e.message || e) });
    }

    let chapters = [];
    try {
      const ch = await director(API, cookieHeader, csrf, cid, "GET", "/chapters");
      chapters = ch?.chapters ?? [];
      report.chapters = chapters.map((c) => c.id || c.chapter_id || c.label);
    } catch (e) {
      report.notes.push(`chapters: ${e.message || e}`);
    }

    for (const ch of chapters) {
      const chapterId = ch.id || ch.chapter_id;
      if (!chapterId) continue;
      const stillId = `chapter-${slug(chapterId)}`;
      try {
        await director(API, cookieHeader, csrf, cid, "POST", "/seek", {
          chapter_id: chapterId,
        });
        await new Promise((r) => setTimeout(r, 800));
        await landAfterSeek(page, base, cid);
        await markStill(page, report, {
          id: stillId,
          file: `${stillId}.png`,
          label: ch.label || ch.chapter_label || chapterId,
        });
      } catch (e) {
        report.missing.push({ id: stillId, reason: String(e.message || e) });
      }
    }

    report.ok = report.assets.length > 0;
  } catch (e) {
    report.fatal = String(e?.stack || e);
    console.error(report.fatal);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }

  await mkdir(outRoot, { recursive: true });
  const manifestPath = resolve(outRoot, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(report, null, 2), "utf8");
  const md = [
    `# Promo capture · ${TAPE}`,
    "",
    `generated ${report.generated_at} · ok=${report.ok}`,
    "",
    "## Stills",
    ...(report.assets.length
      ? report.assets.map((a) => `- \`${a.id}\` — ${a.label}`)
      : ["- (none)"]),
    "",
    report.missing.length ? "## Missing" : "",
    ...report.missing.map((m) => `- \`${m.id}\`: ${m.reason}`),
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  await writeFile(resolve(outRoot, "MANIFEST.md"), md, "utf8");
  console.log("CAPTURE", JSON.stringify({ ok: report.ok, stills: report.assets.length, out: outRoot }));
  process.exitCode = report.ok ? 0 : 1;
}

/**
 * @param {{ tape?: string, out?: string }} opts
 */
export async function run(opts = {}) {
  const paths = resolveCapturePaths(opts);
  TAPE = paths.tape;
  outRoot = paths.outRoot;
  stillsDir = paths.stillsDir;
  const creds = loadCreds();
  USER = creds.user;
  PASS = creds.pass;
  API = creds.api;
  PORT = creds.port;
  CAPTURE_SPEED = Number(process.env.PROMO_SPEED ?? 8);
  GAP = Number(process.env.PROMO_GAP ?? 800);
  HEADED = process.env.PROMO_HEADED === "1";
  process.env.VITE_API_URL = API;
  await main();
}
