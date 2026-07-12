// 图表取数信标 (V1) —— 现场对照验证：同一张"恶意图表"，分别在
//   ① 修复前（没有门卫 loader）  ② 修复后（装上与 Diagram.tsx 相同的门卫 loader，?safe=1）
// 下渲染，看本地信标各被打中几次。修复后应为 0。
//
// 跑法（先在另一终端起信标：node apps/desktop/poc/xss-beacon-listener.mjs）：
//   node apps/desktop/poc/vega-beacon-demo.mjs
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "vega-beacon");

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

/** 渲染一次，回收这次渲染向信标端口发出的所有请求。safe=true 走 ?safe=1（装门卫）。 */
async function renderOnce(safe) {
  const page = await browser.newPage();
  const hits = [];
  page.on("request", (req) => {
    if (req.url().includes("127.0.0.1:9099")) {
      hits.push(`${req.method()} ${req.url()}`);
    }
  });
  const url = new URL(base);
  if (safe) url.searchParams.set("safe", "1");
  await page.goto(url.href, { waitUntil: "load", timeout: 30_000 });
  await page.waitForSelector("#demo-done", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: resolve(
      here,
      safe ? "vega-beacon-fixed.png" : "vega-beacon-shot.png",
    ),
    fullPage: true,
  });
  const err = await page.evaluate(() => window.__demoError);
  await page.close();
  return { hits, err };
}

console.log("\n[1/2] 修复前渲染（无门卫，全程无点击）……");
const before = await renderOnce(false);
console.log("[2/2] 修复后渲染（装上门卫 loader，全程无点击）……");
const after = await renderOnce(true);

await browser.close();
await server.close();

console.log("\n================ 对照结论 ================");
console.log(
  `修复前：信标被打中 ${before.hits.length} 次` +
    (before.hits.length ? `\n     → ${before.hits.join("\n     → ")}` : ""),
);
console.log(
  `修复后：信标被打中 ${after.hits.length} 次` +
    (after.hits.length
      ? `\n     → ${after.hits.join("\n     → ")}`
      : "（门卫拦下了，未联网）"),
);
console.log(
  "\n" +
    (before.hits.length > 0 && after.hits.length === 0
      ? "✅ 修复有效：同一张恶意图表，装门卫后不再替攻击者联网。"
      : "⚠️ 结果不符合预期，请检查门卫是否正确装上。"),
);
process.exit(0);
