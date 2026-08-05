#!/usr/bin/env node
/**
 * 桌面自动更新 CDN 测速（对照 electron-updater 差分 Range 形态）。
 *
 * 用法：
 *   node deploy/scripts/probe-updater-cdn.mjs
 *   node deploy/scripts/probe-updater-cdn.mjs --base https://downloads.fashitianxia.xyz/desktop
 *   node deploy/scripts/probe-updater-cdn.mjs --also-github
 *   # 贴近真实 blockmap（本仓 Win 包约 20KiB/块）的串行差分压测：
 *   node deploy/scripts/probe-updater-cdn.mjs --small-range 20480 --diff-bytes 2097152
 *
 * 测：latest.yml / blockmap 首包延迟、大块单 Range、串行小 Range（模拟差分）、
 * multipart 多 Range 是否被接受。可选对比 GitHub Releases 同名资产。
 */
import { gunzipSync } from "node:zlib";

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(name);
}
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const CDN_BASE = opt(
  "--base",
  "https://downloads.fashitianxia.xyz/desktop",
).replace(/\/$/, "");
const ALSO_GITHUB = flag("--also-github");
/** 模拟差分：串行小 Range 总字节（默认贴近本机日志 ~8.5MB）。 */
const DIFF_BUDGET = Number(opt("--diff-bytes", "8916216"));
/** 单次小 Range 目标大小（默认 256KiB；真实 block 常更大，小块更能压出隧道延迟）。 */
const SMALL_RANGE = Number(opt("--small-range", String(256 * 1024)));
/** 大块单 Range（对照「一次拉完」）。 */
const LARGE_RANGE = Number(opt("--large-range", String(8 * 1024 * 1024)));

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function fmtRate(bytes, ms) {
  const s = Math.max(ms / 1000, 0.001);
  const kbps = bytes / 1024 / s;
  const mbps = bytes / (1024 * 1024) / s;
  return `${kbps.toFixed(1)} KiB/s (${mbps.toFixed(2)} MiB/s)`;
}

function header(res, name) {
  return res.headers.get(name) ?? res.headers.get(name.toLowerCase()) ?? null;
}

async function fetchTimed(url, init = {}) {
  const t0 = performance.now();
  const res = await fetch(url, {
    ...init,
    redirect: "follow",
  });
  const ttfb = performance.now() - t0;
  return { res, ttfb };
}

async function readAll(res) {
  const t0 = performance.now();
  const buf = Buffer.from(await res.arrayBuffer());
  const readMs = performance.now() - t0;
  return { buf, readMs };
}

async function rangeGet(url, start, endInclusive) {
  const { res, ttfb } = await fetchTimed(url, {
    headers: { Range: `bytes=${start}-${endInclusive}`, Accept: "*/*" },
  });
  const { buf, readMs } = await readAll(res);
  return {
    status: res.status,
    ttfbMs: Math.round(ttfb),
    readMs: Math.round(readMs),
    totalMs: Math.round(ttfb + readMs),
    bytes: buf.length,
    cfCache: header(res, "cf-cache-status"),
    acceptRanges: header(res, "accept-ranges"),
    contentType: header(res, "content-type"),
    contentRange: header(res, "content-range"),
  };
}

async function headMeta(url) {
  const { res, ttfb } = await fetchTimed(url, { method: "HEAD" });
  return {
    status: res.status,
    ttfbMs: Math.round(ttfb),
    contentLength: Number(header(res, "content-length") || 0),
    cfCache: header(res, "cf-cache-status"),
    acceptRanges: header(res, "accept-ranges"),
  };
}

async function getText(url) {
  const { res, ttfb } = await fetchTimed(url);
  const text = await res.text();
  return {
    status: res.status,
    ttfbMs: Math.round(ttfb),
    bytes: Buffer.byteLength(text),
    text,
    cfCache: header(res, "cf-cache-status"),
  };
}

function parseLatestYml(text) {
  const version = (text.match(/^version:\s*['"]?([^\s'"]+)/m) || [])[1];
  const path =
    (text.match(/^path:\s*['"]?([^\s'"]+)/m) || [])[1] ||
    (text.match(/^\s+-\s+url:\s*['"]?([^\s'"]+)/m) || [])[1];
  const size = Number((text.match(/^\s+size:\s*(\d+)/m) || [])[1] || 0);
  return { version, path, size };
}

function summarizeBlockmap(buf) {
  let json;
  try {
    json = gunzipSync(buf).toString("utf8");
  } catch {
    json = buf.toString("utf8");
  }
  const data = JSON.parse(json);
  const file = data.files?.[0];
  const sizes = file?.sizes || [];
  const sum = sizes.reduce((a, b) => a + b, 0);
  const avg = sizes.length ? sum / sizes.length : 0;
  return {
    version: data.version,
    blocks: sizes.length,
    avgBlock: Math.round(avg),
    minBlock: sizes.length ? Math.min(...sizes) : 0,
    maxBlock: sizes.length ? Math.max(...sizes) : 0,
  };
}

async function probeHost(label, exeUrl, meta = {}) {
  console.log(`\n======== ${label} ========`);
  console.log(`exe: ${exeUrl}`);

  const head = await headMeta(exeUrl);
  console.log(
    `HEAD: status=${head.status} ttfb=${head.ttfbMs}ms len=${fmtBytes(head.contentLength)} accept-ranges=${head.acceptRanges} cf=${head.cfCache}`,
  );
  if (head.status >= 400 || head.contentLength <= 0) {
    console.log("skip body probes (HEAD failed or empty)");
    return { label, ok: false, head };
  }

  const fileSize = head.contentLength;
  const largeEnd = Math.min(LARGE_RANGE, fileSize) - 1;
  const large = await rangeGet(exeUrl, 0, largeEnd);
  console.log(
    `LARGE single Range 0-${largeEnd}: status=${large.status} bytes=${fmtBytes(large.bytes)} ttfb=${large.ttfbMs}ms total=${large.totalMs}ms → ${fmtRate(large.bytes, large.totalMs)} cf=${large.cfCache}`,
  );

  // 串行小 Range：散布在文件前部，贴近差分「很多不连续块」
  const chunk = Math.min(SMALL_RANGE, Math.floor(fileSize / 64));
  const stride = Math.max(chunk * 4, 1024 * 1024);
  let offset = 0;
  let pulled = 0;
  let ranges = 0;
  let sumTtfb = 0;
  let maxTtfb = 0;
  const t0 = performance.now();
  const samples = [];
  while (pulled < DIFF_BUDGET && offset + chunk - 1 < fileSize) {
    const end = offset + chunk - 1;
    const r = await rangeGet(exeUrl, offset, end);
    ranges += 1;
    pulled += r.bytes;
    sumTtfb += r.ttfbMs;
    maxTtfb = Math.max(maxTtfb, r.ttfbMs);
    if (samples.length < 5 || r.ttfbMs > 2000) {
      samples.push({
        n: ranges,
        off: offset,
        ttfb: r.ttfbMs,
        total: r.totalMs,
        status: r.status,
        cf: r.cfCache,
      });
    }
    if (r.status !== 206 && r.status !== 200) {
      console.log(`SMALL Range abort at #${ranges}: status=${r.status}`);
      break;
    }
    offset += stride;
  }
  const wallMs = Math.round(performance.now() - t0);
  console.log(
    `SMALL serial Ranges: count=${ranges} bytes=${fmtBytes(pulled)} wall=${wallMs}ms avgTtfb=${Math.round(sumTtfb / Math.max(ranges, 1))}ms maxTtfb=${maxTtfb}ms → ${fmtRate(pulled, wallMs)}`,
  );
  for (const s of samples) {
    console.log(
      `  sample #${s.n} off=${s.off} status=${s.status} ttfb=${s.ttfb}ms total=${s.total}ms cf=${s.cf}`,
    );
  }

  // multipart：electron-updater generic 默认会试；CF/nginx 常不支持
  const multiStart = 0;
  const multiA = Math.min(64 * 1024, fileSize) - 1;
  const multiB0 = Math.min(2 * 1024 * 1024, fileSize - 1);
  const multiB1 = Math.min(multiB0 + 64 * 1024, fileSize) - 1;
  const multiHdr = `bytes=${multiStart}-${multiA}, ${multiB0}-${multiB1}`;
  const { res: multiRes, ttfb: multiTtfb } = await fetchTimed(exeUrl, {
    headers: { Range: multiHdr, Accept: "*/*" },
  });
  const multiCt = header(multiRes, "content-type");
  const multiBody = await multiRes.arrayBuffer();
  console.log(
    `MULTIPART Range "${multiHdr}": status=${multiRes.status} ttfb=${Math.round(multiTtfb)}ms ct=${multiCt} body=${fmtBytes(multiBody.byteLength)} (updater needs multipart/byteranges)`,
  );

  return {
    label,
    ok: true,
    head,
    large,
    small: {
      ranges,
      pulled,
      wallMs,
      avgTtfb: Math.round(sumTtfb / Math.max(ranges, 1)),
      maxTtfb,
      rate: fmtRate(pulled, wallMs),
    },
    multipart: {
      status: multiRes.status,
      contentType: multiCt,
      ttfbMs: Math.round(multiTtfb),
    },
    meta,
  };
}

async function main() {
  console.log(`CDN base: ${CDN_BASE}`);
  console.log(
    `params: large=${fmtBytes(LARGE_RANGE)} small=${fmtBytes(SMALL_RANGE)} diffBudget=${fmtBytes(DIFF_BUDGET)}`,
  );

  const yml = await getText(`${CDN_BASE}/latest.yml`);
  console.log(
    `\nlatest.yml: status=${yml.status} ttfb=${yml.ttfbMs}ms bytes=${yml.bytes} cf=${yml.cfCache}`,
  );
  const parsed = parseLatestYml(yml.text);
  console.log(
    `parsed: version=${parsed.version} path=${parsed.path} size=${fmtBytes(parsed.size)}`,
  );
  if (!parsed.path) {
    throw new Error("cannot parse path from latest.yml");
  }

  const exeCdn = `${CDN_BASE}/${parsed.path}`;
  const blockmapUrl = `${exeCdn}.blockmap`;
  const bm = await fetchTimed(blockmapUrl);
  const bmBody = await readAll(bm.res);
  console.log(
    `blockmap: status=${bm.res.status} ttfb=${Math.round(bm.ttfb)}ms bytes=${fmtBytes(bmBody.buf.length)} cf=${header(bm.res, "cf-cache-status")}`,
  );
  try {
    const bmInfo = summarizeBlockmap(bmBody.buf);
    console.log(
      `blockmap blocks=${bmInfo.blocks} avg=${fmtBytes(bmInfo.avgBlock)} min=${fmtBytes(bmInfo.minBlock)} max=${fmtBytes(bmInfo.maxBlock)}`,
    );
  } catch (e) {
    console.log(`blockmap parse skip: ${e instanceof Error ? e.message : e}`);
  }

  const cdn = await probeHost("downloads CDN", exeCdn, { version: parsed.version });

  let gh = null;
  if (ALSO_GITHUB) {
    const ghUrl = `https://github.com/Lawofall/AgentCore-releases/releases/download/v${parsed.version}/${parsed.path}`;
    try {
      gh = await probeHost("GitHub Releases", ghUrl, {
        version: parsed.version,
      });
    } catch (e) {
      console.log(
        `\n======== GitHub Releases ========\nFAILED: ${e instanceof Error ? e.message : e}`,
      );
      gh = { label: "GitHub Releases", ok: false, error: String(e) };
    }
  }

  console.log("\n======== verdict ========");
  if (cdn.ok) {
    const largeRate =
      cdn.large.bytes / Math.max(cdn.large.totalMs / 1000, 0.001);
    const smallRate =
      cdn.small.pulled / Math.max(cdn.small.wallMs / 1000, 0.001);
    const ratio = largeRate / Math.max(smallRate, 1);
    console.log(
      `CDN large/small throughput ratio ≈ ${ratio.toFixed(1)}x (>>1 ⇒ 差分小 Range / 每请求 RTT 是瓶颈)`,
    );
    console.log(
      `CDN multipart usable: ${String(cdn.multipart.contentType || "").includes("multipart")}`,
    );
  }
  if (gh?.ok) {
    console.log(
      `GitHub small Range: ${gh.small.rate} (wall ${gh.small.wallMs}ms, ${gh.small.ranges} ranges)`,
    );
    console.log(
      `CDN small Range:    ${cdn.small.rate} (wall ${cdn.small.wallMs}ms, ${cdn.small.ranges} ranges)`,
    );
  } else if (ALSO_GITHUB) {
    console.log("GitHub probe unavailable (timeout/network) — CDN-only verdict stands.");
  }
  console.log(
    "\nTip: 本机真实差分日志在 %APPDATA%/agentcore-desktop/logs/desktop.jsonl （event=updater.download_*）",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
