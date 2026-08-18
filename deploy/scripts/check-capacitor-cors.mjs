#!/usr/bin/env node
/**
 * Capacitor Android WebView CORS preflight against the public API (Nginx path).
 *
 * APK origin is https://localhost / capacitor://localhost / http://localhost.
 * Mobile-web Pages cannot catch a missing allowlist — only a public OPTIONS
 * probe can. Must NOT hit 127.0.0.1:8000 (bypasses Nginx CORS rewrite).
 *
 * Fail closed only on a completed reply that denies a Capacitor origin or
 * allows a forged origin (wildcard). Probe / network failure fail-opens with
 * a loud warning — same posture as assertBackendContractSatisfied.
 *
 *   node deploy/scripts/check-capacitor-cors.mjs
 *   node deploy/scripts/check-capacitor-cors.mjs --api-url https://app.example.com/api
 *   node --test deploy/scripts/check-capacitor-cors.test.mjs
 */
import { pathToFileURL } from "node:url";
import { loadDeployEnv } from "./load-deploy-env.mjs";

export const CAPACITOR_ORIGINS = Object.freeze([
  "https://localhost",
  "capacitor://localhost",
  "http://localhost",
]);

/** Negative control — must never appear in Access-Control-Allow-Origin. */
export const FORGED_ORIGIN = "https://agentcore-cors-probe.invalid";

export const PREFLIGHT_PATH = "/version";

const PROBE_TIMEOUT_MS = 10_000;

export function probeUrl(apiBaseUrl) {
  return `${String(apiBaseUrl ?? "").replace(/\/$/, "")}${PREFLIGHT_PATH}`;
}

export function isProbeablePublicApiUrl(apiBaseUrl) {
  let hostname;
  try {
    hostname = new URL(apiBaseUrl).hostname;
  } catch {
    return false;
  }
  if (!hostname) return false;
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0"
  ) {
    return false;
  }
  if (host === "example.com" || host.endsWith(".example.com")) return false;
  return true;
}

export function readAcao(headers) {
  if (!headers) return "";
  let raw;
  if (typeof headers.get === "function") {
    raw = headers.get("access-control-allow-origin");
  } else {
    raw =
      headers["access-control-allow-origin"] ??
      headers["Access-Control-Allow-Origin"];
  }
  return String(raw ?? "").trim();
}

function isProbeFailureStatus(status) {
  return (
    !Number.isFinite(status) ||
    status === 0 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

function isAmbiguousStatus(status) {
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    (status >= 300 && status < 400)
  );
}

/**
 * @param {{ origin: string, status: number, acao: string }} input
 * @returns {{ kind: "pass" } | { kind: "fail", reason: string } | { kind: "skip", reason: string }}
 */
export function judgeAllowedOrigin({ origin, status, acao }) {
  if (isProbeFailureStatus(status)) {
    return { kind: "skip", reason: `HTTP ${status}` };
  }
  if (isAmbiguousStatus(status)) {
    return { kind: "skip", reason: `HTTP ${status}` };
  }
  if (acao === origin) return { kind: "pass" };
  if (status === 400 || (status >= 200 && status < 300)) {
    return {
      kind: "fail",
      reason: acao
        ? `Access-Control-Allow-Origin=${acao}（须回显 ${origin}）`
        : `未回显 Access-Control-Allow-Origin: ${origin}`,
    };
  }
  return { kind: "skip", reason: `HTTP ${status}` };
}

/**
 * @param {{ origin: string, status: number, acao: string }} input
 * @returns {{ kind: "pass" } | { kind: "fail", reason: string } | { kind: "skip", reason: string }}
 */
export function judgeForgedOrigin({ origin, status, acao }) {
  if (isProbeFailureStatus(status)) {
    return { kind: "skip", reason: `HTTP ${status}` };
  }
  if (isAmbiguousStatus(status)) {
    return { kind: "skip", reason: `HTTP ${status}` };
  }
  if (acao) {
    return {
      kind: "fail",
      reason: `对照源 ${origin} 仍带回 Access-Control-Allow-Origin=${acao}`,
    };
  }
  if (status === 400 || (status >= 200 && status < 300)) {
    return { kind: "pass" };
  }
  return { kind: "skip", reason: `HTTP ${status}` };
}

export function resolvePublicApiUrl({ env = process.env, argv = process.argv } = {}) {
  const i = argv.indexOf("--api-url");
  if (i >= 0 && argv[i + 1]) return argv[i + 1].trim();
  const APP_HOST = env.AGENTCORE_APP_HOST || "app.fashitianxia.xyz";
  return (
    env.AGENTCORE_APP_API_URL ||
    env.VITE_API_URL ||
    `https://${APP_HOST}/api`
  );
}

/**
 * @param {{ origin: string, ok: boolean, status?: number, acao?: string, error?: Error }} probe
 * @param {"allow" | "forge"} side
 */
export function judgeProbe(probe, side) {
  if (!probe.ok) {
    const msg = probe.error?.message ?? String(probe.error ?? "probe failed");
    return { kind: "skip", reason: msg };
  }
  const input = {
    origin: probe.origin,
    status: probe.status ?? 0,
    acao: probe.acao ?? "",
  };
  return side === "forge" ? judgeForgedOrigin(input) : judgeAllowedOrigin(input);
}

export async function probeOrigin(
  apiBaseUrl,
  origin,
  { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {},
) {
  const url = probeUrl(apiBaseUrl);
  try {
    const res = await fetchImpl(url, {
      method: "OPTIONS",
      redirect: "manual",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = "";
    try {
      if (typeof res.text === "function") body = await res.text();
    } catch {
      /* ignore unread body */
    }
    return {
      origin,
      ok: true,
      status: res.status,
      acao: readAcao(res.headers),
      body,
    };
  } catch (error) {
    return { origin, ok: false, error };
  }
}

/**
 * @returns {Promise<{
 *   outcome: "pass" | "fail" | "skip",
 *   apiBaseUrl: string,
 *   probeUrl: string,
 *   warnings: string[],
 *   failures: string[],
 * }>}
 */
export async function checkCapacitorCors({
  apiBaseUrl,
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const warnings = [];
  const failures = [];
  const trimmed = String(apiBaseUrl ?? "").trim();
  if (!trimmed) {
    return {
      outcome: "skip",
      apiBaseUrl: trimmed,
      probeUrl: "",
      warnings: ["⚠ Capacitor CORS：未配置 API 基址 — 跳过校验"],
      failures,
    };
  }
  const url = probeUrl(trimmed);
  if (!isProbeablePublicApiUrl(trimmed)) {
    return {
      outcome: "skip",
      apiBaseUrl: trimmed,
      probeUrl: url,
      warnings: [
        `⚠ Capacitor CORS：API 基址不是公网 Nginx 链路（${trimmed}）— 跳过校验`,
      ],
      failures,
    };
  }

  let passCount = 0;
  const skipNotes = [];
  for (const origin of CAPACITOR_ORIGINS) {
    const probe = await probeOrigin(trimmed, origin, { fetchImpl, timeoutMs });
    const judged = judgeProbe(probe, "allow");
    if (judged.kind === "pass") passCount += 1;
    else if (judged.kind === "fail") {
      failures.push(`  ${origin}: ${judged.reason}`);
    } else {
      skipNotes.push(`${origin}: ${judged.reason}`);
    }
  }

  const forged = await probeOrigin(trimmed, FORGED_ORIGIN, {
    fetchImpl,
    timeoutMs,
  });
  const forgedJudged = judgeProbe(forged, "forge");
  if (forgedJudged.kind === "pass") passCount += 1;
  else if (forgedJudged.kind === "fail") {
    failures.push(`  ${FORGED_ORIGIN}: ${forgedJudged.reason}`);
  } else {
    skipNotes.push(`对照源: ${forgedJudged.reason}`);
  }

  if (failures.length > 0) {
    return {
      outcome: "fail",
      apiBaseUrl: trimmed,
      probeUrl: url,
      warnings,
      failures,
    };
  }

  const expected = CAPACITOR_ORIGINS.length + 1;
  if (passCount === expected) {
    return {
      outcome: "pass",
      apiBaseUrl: trimmed,
      probeUrl: url,
      warnings,
      failures,
    };
  }

  // All probes skipped → one 契约门禁-style line. Mixed pass+skip keeps per-origin notes.
  if (passCount === 0) {
    warnings.push(
      `⚠ Capacitor CORS：读不到 ${url}（${skipNotes[0] ?? "探测失败"}）— 跳过校验`,
    );
  } else {
    for (const note of skipNotes) {
      warnings.push(`⚠ Capacitor CORS：${note} — 跳过该源`);
    }
  }
  return {
    outcome: "skip",
    apiBaseUrl: trimmed,
    probeUrl: url,
    warnings,
    failures,
  };
}

export async function assertCapacitorCors(opts = {}) {
  let result;
  try {
    result = await checkCapacitorCors(opts);
  } catch (err) {
    console.warn(
      `⚠ Capacitor CORS：探测本身失败（${err?.message ?? err}）— 跳过校验`,
    );
    return;
  }
  for (const line of result.warnings) console.warn(line);
  if (result.outcome === "fail") {
    console.error(
      [
        "",
        "✖ 出包被拦截：生产 CORS 未放行 Capacitor WebView 源。",
        `  探测: ${result.probeUrl}（须走公网 /api，勿打 127.0.0.1:8000）`,
        ...result.failures,
        "  允许源预检须回显该 Origin；对照源不得带 Access-Control-Allow-Origin。",
        "  先把 CORS_ALLOW_ORIGINS 补上 https://localhost,capacitor://localhost,http://localhost 再 recreate api。",
        "  运维补洞：node deploy/scripts/add-capacitor-cors.mjs",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  if (result.outcome === "pass") {
    console.log(
      `✓ Capacitor CORS：公网预检放行 ${CAPACITOR_ORIGINS.join(" / ")}，对照源未回显`,
    );
    return result;
  }
  if (result.warnings.length === 0) {
    console.warn("⚠ Capacitor CORS：探测未完成 — 跳过校验");
  }
  return result;
}

async function main() {
  loadDeployEnv();
  await assertCapacitorCors({ apiBaseUrl: resolvePublicApiUrl() });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.warn(
      `⚠ Capacitor CORS：探测本身失败（${err?.message ?? err}）— 跳过校验`,
    );
  });
}
