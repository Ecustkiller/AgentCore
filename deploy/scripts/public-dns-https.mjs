/**
 * 公开 DNS（DoH）解析 + IP 固定的 HTTPS 客户端——给发布探针/门禁用。
 *
 * 为什么不用本机 resolver：品牌下载域走 Cloudflare Tunnel，开发机的 DNS 可能把它
 * 解析到 Tunnel 后的源站 IP，那台只有一张签给该 IP 的内部短效证书（本就不面向用户），
 * 于是 Node 直连报 CERT_HAS_EXPIRED，而真实用户经 Cloudflare 拿到的是有效通配证书。
 * 用本机解析探测线上，只会得到假警报。
 *
 * 做法：先向公开 DoH 端点（写死 anycast IP，证书含 IP SAN，因而查询本身不经本机
 * resolver）查 A/AAAA，再把 TCP 连接 pin 到解析出的 IP；SNI 与 Host 仍是原主机名，
 * 证书按主机名校验——等价于真实用户路径。
 *
 * DoH 不可用时**明确降级**：打印警告、`dns.verified=false`，且降级下的证书/连接错误
 * 会被包装成「未能按公开解析校验」，不冒充线上故障。
 */
import { Agent, request as httpsRequest } from "node:https";
import { isIP, isIPv6 } from "node:net";

/**
 * 公开 DoH 端点。写死 IP 的（证书含 IP SAN）完全不碰本机 DNS，最干净；
 * 带主机名的作陪跑——本机 DNS 只用来找解析器本身，答案仍来自公开解析器，
 * 且证书按解析器主机名校验，本机被投毒也冒充不了。
 *
 * 全部并发跑、取最先成功者：不同地区各有若干端点被墙（本机 1.1.1.1/8.8.8.8 不通），
 * 串行逐个超时会把「轻量检查」拖成十几秒。
 */
const DOH_ENDPOINTS = [
  { label: "cloudflare(1.1.1.1)", url: "https://1.1.1.1/dns-query" },
  { label: "cloudflare-dns.com", url: "https://cloudflare-dns.com/dns-query" },
  { label: "google(8.8.8.8)", url: "https://8.8.8.8/resolve" },
  { label: "alidns(223.5.5.5)", url: "https://223.5.5.5/resolve" },
  { label: "doh.pub(1.12.12.12)", url: "https://1.12.12.12/dns-query" },
];

const DOH_DEADLINE_MS = 4000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

const DEFAULT_HEADERS = {
  "user-agent": "agentcore-release-probe/1",
  // Node 的 http 客户端不自动解压；显式 identity 免得拿到压缩体后字节数失真。
  "accept-encoding": "identity",
};

/** TLS 校验类错误——降级解析下不足以判定线上异常。 */
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** 复用连接（贴近 electron-updater 的串行 Range 形态）；结束时 closeConnections()。 */
const AGENT = new Agent({ keepAlive: true, maxSockets: 8 });

/**
 * @typedef {object} ResolvedHost
 * @property {string} hostname
 * @property {string[]} addresses 公开解析出的 IP；降级时为空
 * @property {string} source 解析来源描述
 * @property {boolean} verified false = 未能按公开解析校验（已回落本机 resolver）
 * @property {string} [reason] 降级原因
 */

/** @type {Map<string, ResolvedHost>} */
const resolveCache = new Map();

/** @param {unknown} err */
function errMsg(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * @param {{ label: string, url: string }} endpoint
 * @param {string} hostname
 * @param {"A" | "AAAA"} type
 * @returns {Promise<string[]>}
 */
async function dohQuery(endpoint, hostname, type) {
  const url = `${endpoint.url}?name=${encodeURIComponent(hostname)}&type=${type}`;
  const hop = await requestOnce(url, {
    headers: { ...DEFAULT_HEADERS, accept: "application/dns-json" },
    deadlineMs: DOH_DEADLINE_MS,
    idleTimeoutMs: DOH_DEADLINE_MS,
  });
  const chunks = [];
  for await (const chunk of hop.res) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  if ((hop.res.statusCode ?? 0) !== 200) {
    throw new Error(`HTTP ${hop.res.statusCode}`);
  }
  const json = JSON.parse(body);
  const wantType = type === "A" ? 1 : 28;
  return (Array.isArray(json.Answer) ? json.Answer : [])
    .filter((a) => a?.type === wantType && typeof a.data === "string")
    .map((a) => a.data.trim())
    .filter((ip) => isIP(ip) !== 0);
}

/**
 * 并发问所有公开 DoH，取最先给出记录者。
 * @param {string} hostname
 * @param {"A" | "AAAA"} type
 * @returns {Promise<{ addresses: string[], source: string }>}
 */
function dohResolveAny(hostname, type) {
  return Promise.any(
    DOH_ENDPOINTS.map(async (endpoint) => {
      let ips;
      try {
        ips = await dohQuery(endpoint, hostname, type);
      } catch (err) {
        throw new Error(`${endpoint.label}: ${errMsg(err)}`);
      }
      if (ips.length === 0) {
        throw new Error(`${endpoint.label}: 无 ${type} 记录`);
      }
      return { addresses: ips, source: `DoH ${endpoint.label}` };
    }),
  );
}

/** @param {unknown} err */
function aggregateReason(err) {
  const errors = /** @type {AggregateError} */ (err)?.errors;
  if (!Array.isArray(errors)) return errMsg(err);
  return errors.map(errMsg).join("; ");
}

/**
 * 按公开 DoH 解析主机名。失败则降级到本机 resolver 并**大声**标注。
 * @param {string} hostname
 * @returns {Promise<ResolvedHost>}
 */
export async function resolvePublicHost(hostname) {
  const key = hostname.toLowerCase();
  const cached = resolveCache.get(key);
  if (cached) return cached;

  /** @type {ResolvedHost} */
  let resolved;
  if (isIP(hostname) !== 0) {
    resolved = {
      hostname,
      addresses: [hostname],
      source: "IP 直连",
      verified: true,
    };
  } else {
    let hit = null;
    let reason = "";
    try {
      hit = await dohResolveAny(hostname, "A");
    } catch (errA) {
      try {
        hit = await dohResolveAny(hostname, "AAAA");
      } catch (errAAAA) {
        reason = `A → ${aggregateReason(errA)} | AAAA → ${aggregateReason(errAAAA)}`;
      }
    }
    if (hit) {
      resolved = {
        hostname,
        addresses: hit.addresses,
        source: hit.source,
        verified: true,
      };
    } else {
      resolved = {
        hostname,
        addresses: [],
        source: "本机 resolver（降级）",
        verified: false,
        reason,
      };
      console.warn(
        `⚠ 公开 DoH 解析 ${hostname} 失败 → 降级用本机 resolver。` +
          `本次「未能按公开解析校验」，证书/可达性异常不足以判定线上故障。原因: ${reason}`,
      );
    }
  }
  resolveCache.set(key, resolved);
  return resolved;
}

/**
 * 把连接钉在给定 IP 上；SNI / Host 由调用方保持原主机名不变。
 * @param {string[]} addresses
 */
function makePinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const wanted =
      options?.family === 4 || options?.family === 6 ? options.family : 0;
    const list = addresses
      .map((address) => ({ address, family: isIPv6(address) ? 6 : 4 }))
      .filter((entry) => wanted === 0 || entry.family === wanted);
    if (list.length === 0) {
      callback(
        new Error(`公开解析未给出 ${hostname} 的 IPv${wanted || "4/6"} 地址`),
      );
      return;
    }
    // autoSelectFamily（Node 20+ 默认）会要 all:true 的数组形态。
    if (options?.all) {
      callback(null, list);
      return;
    }
    callback(null, list[0].address, list[0].family);
  };
}

/**
 * @param {string} url
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   lookup?: Function,
 *   idleTimeoutMs?: number,
 *   deadlineMs?: number,
 * }} opts
 */
function requestOnce(url, opts = {}) {
  const {
    method = "GET",
    headers = {},
    lookup,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    deadlineMs = 0,
  } = opts;
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let deadline = null;

    const req = httpsRequest(
      url,
      { method, headers, agent: AGENT, ...(lookup ? { lookup } : {}) },
      (res) => {
        if (settled) {
          res.resume();
          return;
        }
        settled = true;
        if (deadline) clearTimeout(deadline);
        const socket = /** @type {import("node:tls").TLSSocket} */ (res.socket);
        const peer =
          typeof socket?.getPeerCertificate === "function"
            ? socket.getPeerCertificate()
            : null;
        resolve({
          res,
          ttfbMs: performance.now() - started,
          cert: peer && Object.keys(peer).length > 0 ? peer : null,
          remoteAddress: socket?.remoteAddress ?? null,
        });
      },
    );

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      req.destroy();
      reject(err);
    };

    if (deadlineMs > 0) {
      deadline = setTimeout(() => {
        fail(new Error(`超时 ${deadlineMs}ms 未响应`));
      }, deadlineMs);
    }
    req.setTimeout(idleTimeoutMs, () => {
      fail(new Error(`连接空闲超过 ${idleTimeoutMs}ms`));
    });
    req.on("error", fail);
    req.end();
  });
}

/**
 * @param {unknown} err
 * @param {string} hostname
 * @param {ResolvedHost} dns
 */
function decorateError(err, hostname, dns) {
  const code = /** @type {{ code?: string }} */ (err)?.code ?? "";
  const isTls = TLS_ERROR_CODES.has(code);
  if (!dns.verified) {
    const head = isTls
      ? `${hostname} 证书校验失败（${code}），但本次**未能按公开解析校验**`
      : `连接 ${hostname} 失败（${code || errMsg(err)}），且**未能按公开解析校验**`;
    const wrapped = new Error(
      `${head}：DoH 不可用已回落本机 resolver，本机可能解析到源站/内网 IP，` +
        `该结果不足以判定线上异常。DoH 失败原因: ${dns.reason ?? "未知"}`,
    );
    wrapped.cause = err;
    return wrapped;
  }
  if (isTls) {
    const wrapped = new Error(
      `${hostname} 证书校验失败（${code}）——已按公开解析 pin 到 ` +
        `${dns.addresses.join(", ")}（${dns.source}），即真实用户路径上的异常`,
    );
    wrapped.cause = err;
    return wrapped;
  }
  return err;
}

/** @param {number | undefined} status */
function isRedirect(status) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

/**
 * 对端证书摘要（含剩余天数）。
 * @param {import("node:tls").PeerCertificate | null} cert
 */
export function certSummary(cert) {
  if (!cert?.valid_to) return null;
  const validTo = new Date(cert.valid_to);
  const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
  const daysLeft = Math.floor(
    (validTo.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
  );
  return {
    subject: cert.subject?.CN ?? "",
    issuer: cert.issuer?.CN ?? cert.issuer?.O ?? "",
    altNames: cert.subjectaltname ?? "",
    validFrom,
    validTo,
    daysLeft,
    expired: daysLeft < 0,
  };
}

/** @param {Date} d */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * 证书一行摘要；临近到期显著提示。
 * @param {ReturnType<typeof certSummary>} tls
 * @param {{ warnDays?: number, criticalDays?: number }} [opts]
 */
export function formatCertLine(tls, opts = {}) {
  if (!tls) return "tls: 证书信息不可用";
  const { warnDays = 30, criticalDays = 14 } = opts;
  let mark = `剩 ${tls.daysLeft} 天`;
  if (tls.expired) mark = `‼ 已过期 ${Math.abs(tls.daysLeft)} 天`;
  else if (tls.daysLeft <= criticalDays)
    mark = `‼ 仅剩 ${tls.daysLeft} 天，尽快续`;
  else if (tls.daysLeft <= warnDays) mark = `⚠ 剩 ${tls.daysLeft} 天`;
  return `tls: CN=${tls.subject || "?"} issuer=${tls.issuer || "?"} 到期 ${fmtDate(tls.validTo)}（${mark}）`;
}

/**
 * 解析来源一行摘要。
 * @param {ResolvedHost} dns
 */
export function formatDnsLine(dns) {
  if (!dns.verified) {
    return `dns: ${dns.hostname} → 本机 resolver（**未能按公开解析校验**：${dns.reason ?? "DoH 不可用"}）`;
  }
  return `dns: ${dns.hostname} → ${dns.addresses.join(", ")}（${dns.source}）`;
}

/**
 * 走公开解析 + IP pin 的 HTTPS 请求；SNI/Host 保持原主机名。
 *
 * @param {string} url
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   idleTimeoutMs?: number,
 *   deadlineMs?: number,
 *   maxRedirects?: number,
 * }} [options]
 */
export async function pinnedRequest(url, options = {}) {
  const {
    headers = {},
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    deadlineMs = 0,
    maxRedirects = MAX_REDIRECTS,
  } = options;
  let method = options.method ?? "GET";
  let current = url;
  /** @type {{ from: string, status: number, to: string }[]} */
  const redirects = [];

  for (let hopIndex = 0; hopIndex <= maxRedirects; hopIndex++) {
    const target = new URL(current);
    if (target.protocol !== "https:") {
      throw new Error(
        `仅支持 https（公开解析 pin 只对 TLS 有意义）: ${current}`,
      );
    }
    const dns = await resolvePublicHost(target.hostname);
    const merged = { ...DEFAULT_HEADERS };
    for (const [k, v] of Object.entries(headers)) merged[k.toLowerCase()] = v;

    let hop;
    try {
      hop = await requestOnce(current, {
        method,
        headers: merged,
        lookup:
          dns.verified && dns.addresses.length > 0
            ? makePinnedLookup(dns.addresses)
            : undefined,
        idleTimeoutMs,
        deadlineMs,
      });
    } catch (err) {
      throw decorateError(err, target.hostname, dns);
    }

    const status = hop.res.statusCode ?? 0;
    const location = hop.res.headers.location;
    if (isRedirect(status) && location && hopIndex < maxRedirects) {
      hop.res.resume();
      const next = new URL(location, current).toString();
      redirects.push({ from: current, status, to: next });
      current = next;
      if (status === 303) method = "GET";
      continue;
    }
    return makeResponse(current, hop, dns, redirects);
  }
  throw new Error(`重定向超过 ${maxRedirects} 跳: ${url}`);
}

/**
 * @param {string} url
 * @param {{ res: import("node:http").IncomingMessage, ttfbMs: number, cert: any, remoteAddress: string | null }} hop
 * @param {ResolvedHost} dns
 * @param {{ from: string, status: number, to: string }[]} redirects
 */
function makeResponse(url, hop, dns, redirects) {
  const { res, ttfbMs, cert, remoteAddress } = hop;
  let consumed = false;
  return {
    url,
    status: res.statusCode ?? 0,
    headers: res.headers,
    ttfbMs,
    ip: remoteAddress,
    dns,
    cert,
    tls: certSummary(cert),
    redirects,
    /** @param {string} name */
    header(name) {
      const value = res.headers[String(name).toLowerCase()];
      if (Array.isArray(value)) return value.join(", ");
      return value ?? null;
    },
    async body() {
      if (consumed) throw new Error("响应体已被读取");
      consumed = true;
      const started = performance.now();
      /** @type {Buffer[]} */
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      return {
        buf: Buffer.concat(chunks),
        readMs: performance.now() - started,
      };
    },
    async text() {
      const { buf, readMs } = await this.body();
      return { text: buf.toString("utf8"), readMs };
    },
    discard() {
      if (consumed) return;
      consumed = true;
      res.resume();
    },
  };
}

/** 释放 keep-alive 连接，让 CLI 能立即退出。 */
export function closeConnections() {
  AGENT.destroy();
}
