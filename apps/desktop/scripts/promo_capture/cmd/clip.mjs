/**
 * clip — SPEED=1 streaming clip + sequence frames.
 * Invoked via: node scripts/promo_capture.mjs clip --tape <id>
 */
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { preview } from "vite";
import { desktopDir, resolveCapturePaths, loadCreds } from "../shared/paths.mjs";
import { dismissOnboarding, ensureDebateRoom } from "../shared/ui.mjs";

let outRoot;
let clipsDir;
let seqDir;
let videoTmp;
let API;
let PORT;
let USER;
let PASS;
let TAPE;

async function main() {
  process.chdir(desktopDir);
  await mkdir(clipsDir, { recursive: true });
  await mkdir(seqDir, { recursive: true });
  await mkdir(videoTmp, { recursive: true });

  const server = await preview({
    configFile: resolve(desktopDir, "vite.webapp.config.ts"),
    preview: { port: PORT, strictPort: true },
  });
  const base = server.resolvedUrls.local[0];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    colorScheme: "light",
    locale: "zh-CN",
    recordVideo: { dir: videoTmp, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  let csrf = null;
  page.on("response", (r) => {
    const t = r.headers()["x-csrf-token"];
    if (t) csrf = t;
  });
  const report = { ok: false };

  try {
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
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    await dismissOnboarding(page);
    const cookies = await context.cookies(API);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const headers = {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    };

    const prep = await (
      await fetch(`${API}/v1/demo-tape/prepare`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          tape_id: TAPE,
          speed: 8,
          max_gap_ms: 600,
        }),
      })
    ).json();
    const cid = prep.conversation_id;
    await page.goto(new URL(`index.webapp.html#/conversations/${cid}`, base).href, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    await dismissOnboarding(page);
    if (prep.user_prompt) await composer.fill(prep.user_prompt);
    await composer.press("Enter");

    await ensureDebateRoom(page);
    await page.waitForTimeout(1500);

    await fetch(`${API}/v1/demo-tape/director/${cid}/speed`, {
      method: "POST",
      headers,
      body: JSON.stringify({ speed: 1 }),
    });
    await fetch(`${API}/v1/demo-tape/director/${cid}/resume`, {
      method: "POST",
      headers,
      body: "{}",
    });
    console.log("speed=1; recording 12s…");

    for (let i = 0; i < 12; i++) {
      await page.screenshot({
        path: resolve(seqDir, `frame-${String(i).padStart(2, "0")}.png`),
        type: "png",
      });
      await page.waitForTimeout(1000);
    }

    report.ok = true;
    report.cid = cid;
    report.sequence = seqDir;
  } catch (e) {
    report.fatal = String(e?.stack || e);
    console.error(report.fatal);
  } finally {
    const vid = page.video();
    await context.close();
    await browser.close();
    await server.close();
    if (vid) {
      try {
        const tmp = await vid.path();
        const dest = resolve(clipsDir, "clip-streaming.webm");
        await copyFile(tmp, dest);
        report.clip = dest;
        console.log("clip written", dest);
      } catch (e) {
        report.notes = String(e);
      }
    }
  }

  try {
    const manPath = resolve(outRoot, "manifest.json");
    const man = JSON.parse(await readFile(manPath, "utf8"));
    man.clips = man.clips || [];
    if (report.clip) {
      man.clips = man.clips.filter((c) => c.id !== "clip-streaming");
      man.clips.push({
        id: "clip-streaming",
        file: "clips/clip-streaming.webm",
        path: report.clip,
        speed: 1,
      });
    }
    man.sequences = man.sequences || [];
    man.sequences = man.sequences.filter((s) => s.id !== "clip-streaming");
    man.sequences.push({
      id: "clip-streaming",
      dir: seqDir,
      interval_ms: 1000,
      speed: 1,
    });
    await writeFile(manPath, JSON.stringify(man, null, 2), "utf8");
  } catch (e) {
    console.error("manifest patch", e);
  }

  console.log("CLIP", JSON.stringify(report));
  process.exitCode = report.ok ? 0 : 1;
}

/**
 * @param {{ tape?: string, out?: string }} opts
 */
export async function run(opts = {}) {
  const paths = resolveCapturePaths(opts);
  outRoot = paths.outRoot;
  clipsDir = paths.clipsDir;
  seqDir = paths.clipSeqDir;
  videoTmp = paths.videoTmpClipDir;
  TAPE = paths.tape;
  const creds = loadCreds();
  USER = creds.user;
  PASS = creds.pass;
  API = creds.api;
  PORT = creds.port;
  process.env.VITE_API_URL = API;
  await main();
}
