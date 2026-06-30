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

const server = await createServer({ root, logLevel: "warn" });
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

/** 渲染一种引擎配置一次，回收这次渲染向信标端口发出的所有请求。 */
async function renderOnce(engine) {
  const page = await browser.newPage();
  const hits = [];
  page.on("request", (req) => {
    if (req.url().includes("127.0.0.1:9099")) {
      hits.push(`${req.method()} ${req.url()}`);
    }
  });
  const url = new URL(base);
  url.searchParams.set("engine", engine);
  await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
  await page.waitForSelector("#demo-done", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: resolve(here, `diagram-beacon-${engine}.png`),
    fullPage: true,
  });
  const err = await page.evaluate(() => window.__demoError);
  await page.close();
  return { hits, err };
}

// 可用 argv 过滤要跑的引擎（如 `node diagram-beacon-demo.mjs mermaid-loose mermaid-strict`）；不传则全跑。
const ALL_ENGINES = ["mermaid-loose", "mermaid-strict", "markmap"];
const engines = process.argv.slice(2).length
  ? process.argv.slice(2).filter((e) => ALL_ENGINES.includes(e))
  : ALL_ENGINES;
const results = {};
for (const e of engines) {
  console.log(`\n渲染 ${e}（全程无点击）……`);
  results[e] = await renderOnce(e);
}

await browser.close();
await server.close();

console.log("\n================ 手验结论 ================");
for (const e of engines) {
  const r = results[e];
  console.log(
    `${e.padEnd(14)}：信标被打中 ${r.hits.length} 次` +
      (r.hits.length ? `\n     → ${r.hits.join("\n     → ")}` : "（未联网）") +
      (r.err ? `\n     (render error: ${r.err})` : ""),
  );
}
console.log("\n判读（以实际命中数为准）：");
console.log(
  "  mermaid-strict（App 真实配置）命中 → V2 坐实：DOMPurify 默认保留 <img src=remote>（只挡脚本/事件，不挡取资源），",
);
console.log(
  "    故 strict 也会在渲染期替攻击者取图。mermaid-loose 命中是同因的对照。",
);
console.log(
  "  markmap 命中 → V3 坐实：markmap 把节点 HTML（含 markdown 图片）渲进 foreignObject，无 DOMPurify。",
);
console.log(
  "  注：本 PoC 无 CSP，用的是 http 信标；App 的 CSP img-src 含 https:，故真实利用改用 https 图床即可绕过 CSP——V2/V3 在 App 内仍成立。",
);
process.exit(0);
