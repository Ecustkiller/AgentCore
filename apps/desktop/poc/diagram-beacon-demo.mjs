// mermaid / markmap 渲染期信标 (V2/V3) —— 现场手验：同一类「恶意图表」在三种配置下渲染，
// 看本地信标各被打中几次。
//   ① mermaid-loose  对照：securityLevel:"loose" —— 预期【命中】（演示降级的危险）
//   ② mermaid-strict = App 真实配置：securityLevel:"strict" —— 预期【0 命中】（DOMPurify 拦下）
//   ③ markmap        = App 真实代码路径 —— 看是否【命中】（markmap 无 DOMPurify，可能是真实漏洞）
//
// 跑法（先在另一终端起信标：node apps/desktop/poc/xss-beacon-listener.mjs）：
//   node apps/desktop/poc/diagram-beacon-demo.mjs
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "diagram-beacon");

// argv：可过滤引擎（如 `… mermaid-loose markmap`）；加 `--csp` 则由 dev server 给 HTML 文档盖上与
// App 等价的 `img-src 'self' data:` 头部 CSP（真实 header，非 meta），验证修复后整类信标被浏览器拦死。
const ALL_ENGINES = ["mermaid-loose", "mermaid-strict", "markmap"];
const argv = process.argv.slice(2);
const useCsp = argv.includes("--csp");
const picked = argv.filter((e) => ALL_ENGINES.includes(e));
const engines = picked.length ? picked : ALL_ENGINES;

// 修复后策略的忠实模拟：只对 HTML 文档（/ 或 /?…）盖 CSP 头，子资源（JS/CSS）照常从 self 加载。
const cspPlugin = {
  name: "poc-csp-header",
  configureServer(s) {
    s.middlewares.use((req, res, next) => {
      const u = req.url ?? "";
      if (u === "/" || u.startsWith("/?")) {
        res.setHeader("Content-Security-Policy", "img-src 'self' data:");
      }
      next();
    });
  },
};

const server = await createServer({
  root,
  logLevel: "warn",
  plugins: useCsp ? [cspPlugin] : [],
});
await server.listen();
const base = server.resolvedUrls?.local?.[0];
if (!base) {
  await server.close();
  throw new Error("Vite 没有报告本地 URL");
}
console.log("页面已起：", base);

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  await server.close();
  console.error(
    `无法启动 Chromium，请先装一次：\n  pnpm -C apps/desktop exec playwright install chromium\n${String(err?.message ?? err)}`,
  );
  process.exit(1);
}

const isBeacon = (u) => u.includes("127.0.0.1:9099");

/** 渲染一种引擎配置一次。
 *  关键：用 **response**（真的收到回包）而非 request 计「命中」——CSP 拦截发生在请求创建之后、出网
 *  之前，Playwright 的 request 事件对被拦请求**仍会触发**，但不会有 response。故只有 response 才证明
 *  真的联网到了信标。requestfailed 记录被拦原因（如 net::ERR_BLOCKED_BY_CSP）。 */
async function renderOnce(engine) {
  const page = await browser.newPage();
  const hits = []; // 真命中：收到回包
  const blocked = []; // 被拦：请求建了但没出网
  page.on("response", (res) => {
    if (isBeacon(res.url())) hits.push(`${res.status()} ${res.url()}`);
  });
  page.on("requestfailed", (req) => {
    if (isBeacon(req.url())) {
      blocked.push(`${req.failure()?.errorText ?? "failed"} ${req.url()}`);
    }
  });
  const url = new URL(base);
  url.searchParams.set("engine", engine);
  const resp = await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
  console.log(
    `   [doc CSP header] ${resp?.headers()["content-security-policy"] ?? "(none)"}`,
  );
  await page.waitForSelector("#demo-done", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: resolve(here, `diagram-beacon-${engine}${useCsp ? "-csp" : ""}.png`),
    fullPage: true,
  });
  const err = await page.evaluate(() => window.__demoError);
  await page.close();
  return { hits, blocked, err };
}

const results = {};
for (const e of engines) {
  console.log(`\n渲染 ${e}（全程无点击${useCsp ? " · 已盖修复后 CSP img-src 'self' data:" : ""}）……`);
  results[e] = await renderOnce(e);
}

await browser.close();
await server.close();

console.log("\n================ 手验结论 ================");
for (const e of engines) {
  const r = results[e];
  console.log(
    `${e.padEnd(14)}：真命中（收到回包）${r.hits.length} 次 · 被拦 ${r.blocked.length} 次` +
      (r.hits.length ? `\n     ✗ 出网 → ${r.hits.join("\n     ✗ 出网 → ")}` : "") +
      (r.blocked.length ? `\n     ✓ 拦下 → ${r.blocked.join("\n     ✓ 拦下 → ")}` : "") +
      (r.err ? `\n     (render error: ${r.err})` : ""),
  );
}
const total = engines.reduce((n, e) => n + results[e].hits.length, 0);
if (useCsp) {
  console.log("\n判读（修复后 · 已盖 CSP img-src 'self' data:）：");
  console.log(
    total === 0
      ? "  ✅ 全部 0 命中：img-src 收窄到 self+data 后，mermaid/markmap 的远程 <img> 被浏览器拦在网络层，整类渲染期信标失效。"
      : "  ⚠️ 仍有命中——CSP 未生效，请检查 header 是否真盖到 HTML 文档。",
  );
} else {
  console.log("\n判读（修复前 · 无 CSP，以实际命中数为准）：");
  console.log(
    "  mermaid-strict（App 真实配置）命中 → V2 坐实：DOMPurify 默认保留 <img src=remote>（只挡脚本/事件，不挡取资源），故 strict 也会渲染期取图。",
  );
  console.log(
    "  markmap 命中 → V3 坐实：markmap 把节点 HTML（含 markdown 图片）渲进 foreignObject，无 DOMPurify。",
  );
  console.log(
    "  注：本 PoC 用 http 信标；App 旧 CSP img-src 含 https:，真实利用改用 https 图床即可绕过——V2/V3 在 App 内成立。加 --csp 复跑可验证修复。",
  );
}
process.exit(0);
