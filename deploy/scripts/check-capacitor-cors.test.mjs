/**
 * Capacitor CORS preflight judges + fail-open aggregation.
 * Run: node --test deploy/scripts/check-capacitor-cors.test.mjs
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPACITOR_ORIGINS,
  FORGED_ORIGIN,
  checkCapacitorCors,
  isProbeablePublicApiUrl,
  judgeAllowedOrigin,
  judgeForgedOrigin,
  probeUrl,
  readAcao,
} from "./check-capacitor-cors.mjs";

const PUBLIC_API = "https://app.fashitianxia.xyz/api";

function mockFetchByOrigin(specByOrigin) {
  return async (_url, init) => {
    const origin = init?.headers?.Origin ?? init?.headers?.origin;
    const spec = specByOrigin[origin];
    if (!spec) throw new Error(`unexpected origin ${origin}`);
    if (spec.throw) throw spec.throw;
    const headers = spec.headers ?? {};
    if (spec.acao !== undefined && headers["access-control-allow-origin"] === undefined) {
      headers["access-control-allow-origin"] = spec.acao;
    }
    return {
      status: spec.status,
      headers: {
        get(name) {
          const key = String(name).toLowerCase();
          return (
            headers[key] ??
            headers[name] ??
            null
          );
        },
      },
      text: async () => spec.body ?? "",
    };
  };
}

function allowAllEcho() {
  /** @type {Record<string, { status: number, acao: string }>} */
  const spec = {};
  for (const origin of CAPACITOR_ORIGINS) {
    spec[origin] = { status: 200, acao: origin };
  }
  spec[FORGED_ORIGIN] = { status: 400, acao: "" };
  return spec;
}

describe("isProbeablePublicApiUrl", () => {
  it("accepts a public https API base", () => {
    assert.equal(isProbeablePublicApiUrl(PUBLIC_API), true);
  });

  it("rejects loopback and docs placeholders (would miss Nginx)", () => {
    assert.equal(isProbeablePublicApiUrl("http://127.0.0.1:8000"), false);
    assert.equal(isProbeablePublicApiUrl("http://localhost:8000/api"), false);
    assert.equal(isProbeablePublicApiUrl("https://app.example.com/api"), false);
    assert.equal(isProbeablePublicApiUrl("not a url"), false);
  });
});

describe("readAcao / probeUrl", () => {
  it("reads ACAO case-insensitively from Headers-like objects", () => {
    assert.equal(
      readAcao({ get: () => "https://localhost" }),
      "https://localhost",
    );
    assert.equal(
      readAcao({ "Access-Control-Allow-Origin": "https://localhost" }),
      "https://localhost",
    );
    assert.equal(readAcao({}), "");
  });

  it("appends /version without doubling slashes", () => {
    assert.equal(probeUrl("https://app.example.com/api"), "https://app.example.com/api/version");
    assert.equal(probeUrl("https://app.example.com/api/"), "https://app.example.com/api/version");
  });
});

describe("judgeAllowedOrigin", () => {
  it("passes only when ACAO echoes the requested origin", () => {
    assert.equal(
      judgeAllowedOrigin({
        origin: "https://localhost",
        status: 200,
        acao: "https://localhost",
      }).kind,
      "pass",
    );
  });

  it("fails on a completed preflight that does not echo the origin", () => {
    const missing = judgeAllowedOrigin({
      origin: "https://localhost",
      status: 200,
      acao: "",
    });
    assert.equal(missing.kind, "fail");
    const starlette = judgeAllowedOrigin({
      origin: "https://localhost",
      status: 400,
      acao: "",
    });
    assert.equal(starlette.kind, "fail");
    const wildcard = judgeAllowedOrigin({
      origin: "https://localhost",
      status: 200,
      acao: "*",
    });
    assert.equal(wildcard.kind, "fail");
  });

  it("skips network-class statuses (fail-open)", () => {
    for (const status of [0, 408, 429, 502, 503, 504]) {
      assert.equal(
        judgeAllowedOrigin({
          origin: "https://localhost",
          status,
          acao: "",
        }).kind,
        "skip",
      );
    }
  });
});

describe("judgeForgedOrigin", () => {
  it("passes when a completed preflight omits ACAO", () => {
    assert.equal(
      judgeForgedOrigin({
        origin: FORGED_ORIGIN,
        status: 400,
        acao: "",
      }).kind,
      "pass",
    );
    assert.equal(
      judgeForgedOrigin({
        origin: FORGED_ORIGIN,
        status: 200,
        acao: "",
      }).kind,
      "pass",
    );
  });

  it("fails when the forged origin is echoed or wildcarded", () => {
    assert.equal(
      judgeForgedOrigin({
        origin: FORGED_ORIGIN,
        status: 200,
        acao: "*",
      }).kind,
      "fail",
    );
    assert.equal(
      judgeForgedOrigin({
        origin: FORGED_ORIGIN,
        status: 200,
        acao: FORGED_ORIGIN,
      }).kind,
      "fail",
    );
  });
});

describe("checkCapacitorCors", () => {
  it("passes when allowed origins echo and the forged origin has no ACAO", async () => {
    const result = await checkCapacitorCors({
      apiBaseUrl: PUBLIC_API,
      fetchImpl: mockFetchByOrigin(allowAllEcho()),
    });
    assert.equal(result.outcome, "pass");
    assert.equal(result.failures.length, 0);
  });

  it("fails when a Capacitor origin is explicitly denied", async () => {
    const spec = allowAllEcho();
    spec["https://localhost"] = { status: 400, acao: "" };
    const result = await checkCapacitorCors({
      apiBaseUrl: PUBLIC_API,
      fetchImpl: mockFetchByOrigin(spec),
    });
    assert.equal(result.outcome, "fail");
    assert.match(result.failures.join("\n"), /https:\/\/localhost/);
  });

  it("fails when a wildcard would also allow the forged origin", async () => {
    const spec = {};
    for (const origin of CAPACITOR_ORIGINS) {
      spec[origin] = { status: 200, acao: "*" };
    }
    spec[FORGED_ORIGIN] = { status: 200, acao: "*" };
    const result = await checkCapacitorCors({
      apiBaseUrl: PUBLIC_API,
      fetchImpl: mockFetchByOrigin(spec),
    });
    assert.equal(result.outcome, "fail");
    assert.match(result.failures.join("\n"), /对照源/);
  });

  it("fail-opens when the probe cannot reach the public API", async () => {
    const result = await checkCapacitorCors({
      apiBaseUrl: PUBLIC_API,
      fetchImpl: mockFetchByOrigin(
        Object.fromEntries(
          [...CAPACITOR_ORIGINS, FORGED_ORIGIN].map((origin) => [
            origin,
            { throw: new Error("fetch failed") },
          ]),
        ),
      ),
    });
    assert.equal(result.outcome, "skip");
    assert.equal(result.failures.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /读不到 .+— 跳过校验/);
  });

  it("fail-opens on loopback API bases without fetching", async () => {
    let called = 0;
    const result = await checkCapacitorCors({
      apiBaseUrl: "http://127.0.0.1:8000",
      fetchImpl: async () => {
        called += 1;
        throw new Error("must not fetch loopback");
      },
    });
    assert.equal(result.outcome, "skip");
    assert.equal(called, 0);
    assert.match(result.warnings[0] ?? "", /公网 Nginx/);
  });
});
