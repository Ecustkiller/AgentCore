/**
 * Capture director-console screenshots with mocked REST (no live tape required).
 *
 *   node scripts/director_console_shot.mjs
 *
 * Writes PNGs under %TEMP%/demo-tape-director/
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  path.join(__dirname, "../../desktop/package.json"),
);
const { chromium } = require("playwright");

const OUT = path.join(os.tmpdir(), "demo-tape-director");
const HTML_PATH = path.join(OUT, "director.html");

const CHAPTERS = [
  { id: "opening", label: "开场检索", t_ms: 0, event_index: 0 },
  { id: "team_preview", label: "组队授权", t_ms: 32000, event_index: 113 },
  { id: "r1_argument", label: "第1轮·立论", t_ms: 52000, event_index: 117 },
  { id: "r1_cross", label: "第1轮·质询", t_ms: 188000, event_index: 839 },
  { id: "r1_score", label: "第1轮·打分", t_ms: 319000, event_index: 1638 },
  { id: "r2_argument", label: "第2轮·立论", t_ms: 319000, event_index: 1639 },
  { id: "r2_cross", label: "第2轮·质询", t_ms: 478000, event_index: 2626 },
  { id: "r2_score", label: "第2轮·打分", t_ms: 598000, event_index: 3216 },
  { id: "r3_argument", label: "第3轮·立论", t_ms: 598000, event_index: 3217 },
  { id: "verdict", label: "终审", t_ms: 1118000, event_index: 5455 },
];

const CID = "c63a1188-20ac-48d4-9c0a-9ede68bc17f3";

let status = {
  conversation_id: CID,
  tape_id: "lv-molihua-trademark",
  tape_path: "demos/tapes/lv-molihua-trademark.json",
  state: "playing",
  speed: 4,
  max_gap_ms: 2000,
  event_index: 840,
  event_count: 5513,
  t_ms: 188000,
  duration_ms: 1180000,
  message_id: "msg-demo",
  burst_until_index: null,
  soft_paused: false,
  chapter_label: "第1轮·质询",
  live: true,
  error: null,
};

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function main() {
  if (!fs.existsSync(HTML_PATH)) {
    console.error("Missing", HTML_PATH, "— export director.html first");
    process.exit(1);
  }
  const html = fs.readFileSync(HTML_PATH, "utf8");
  fs.mkdirSync(OUT, { recursive: true });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const p = url.pathname;

    if (req.method === "GET" && (p === "/" || p === "/v1/demo-tape/director")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "POST" && p === "/v1/auth/token") {
      json(res, 200, { access_token: "shot-token", token_type: "bearer" });
      return;
    }
    if (req.method === "GET" && p === "/v1/demo-tape/director/sessions") {
      json(res, 200, { sessions: [{ ...status }] });
      return;
    }
    if (req.method === "GET" && p.endsWith("/chapters")) {
      json(res, 200, { conversation_id: CID, chapters: CHAPTERS });
      return;
    }
    if (req.method === "GET" && p.endsWith("/status")) {
      json(res, 200, status);
      return;
    }
    if (req.method === "POST" && p.endsWith("/pause")) {
      status = { ...status, soft_paused: true, state: status.state === "playing" ? "paused" : status.state };
      json(res, 200, status);
      return;
    }
    if (req.method === "POST" && p.endsWith("/resume")) {
      status = { ...status, soft_paused: false, state: status.state === "paused" ? "playing" : status.state };
      json(res, 200, status);
      return;
    }
    if (req.method === "POST" && p.endsWith("/speed")) {
      const body = await readBody(req);
      status = { ...status, speed: body.speed ?? status.speed };
      json(res, 200, status);
      return;
    }
    if (req.method === "POST" && p.endsWith("/seek")) {
      const body = await readBody(req);
      if (body.chapter_id) {
        const ch = CHAPTERS.find((c) => c.id === body.chapter_id);
        if (ch) {
          status = {
            ...status,
            t_ms: ch.t_ms,
            event_index: ch.event_index,
            chapter_label: ch.label,
            state: "playing",
            soft_paused: false,
          };
        }
      } else if (body.t_ms != null) {
        status = { ...status, t_ms: body.t_ms, chapter_label: "seek" };
      }
      json(res, 200, status);
      return;
    }
    json(res, 404, { detail: "not found " + p });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  console.log("mock server", origin);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 980, height: 1400 } });

  // Shot 1: login / connection form
  await page.goto(origin + "/v1/demo-tape/director", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btnLogin");
  // ensure logged-out view
  await page.evaluate(() => localStorage.removeItem("demo_tape_director_token"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".auth-form");
  const shotLogin = path.join(OUT, "director-01-login.png");
  await page.screenshot({ path: shotLogin, fullPage: true });
  console.log("wrote", shotLogin);

  // Shot 2: main transport + chapters after login
  await page.fill("#user", "dev");
  await page.fill("#pass", "devpassword");
  await page.click("#btnLogin");
  await page.waitForSelector("#authPanel.collapsed");
  await page.waitForSelector(".chapter-wall button");
  await page.waitForFunction(() => {
    const el = document.getElementById("heroState");
    return el && el.textContent.includes("播放");
  });
  const shotMain = path.join(OUT, "director-02-control-chapters.png");
  await page.screenshot({ path: shotMain, fullPage: true });
  console.log("wrote", shotMain);

  // Bonus: awaiting + soft pause distinction
  status = {
    ...status,
    state: "awaiting_interaction",
    soft_paused: true,
    chapter_label: "组队授权",
    t_ms: 32000,
  };
  await page.waitForTimeout(500);
  const shotAwait = path.join(OUT, "director-03-awaiting-paused.png");
  await page.screenshot({ path: shotAwait, fullPage: true });
  console.log("wrote", shotAwait);

  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
