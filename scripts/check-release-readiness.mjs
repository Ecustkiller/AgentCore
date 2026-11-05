#!/usr/bin/env node
/**
 * Fail closed before publishing a desktop release when the hosted service is not
 * healthy or the renderer was baked with the wrong API base.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function productionApiBase() {
  if (process.env.PUBLIC_API_URL?.trim()) {
    return process.env.PUBLIC_API_URL.trim().replace(/\/$/, "");
  }
  const env = readFileSync(join(root, "apps/desktop/.env.production"), "utf8");
  const match = /^VITE_API_URL=(.+)$/m.exec(env);
  return (match?.[1]?.trim() || "https://app.fashitianxia.xyz/api").replace(
    /\/$/,
    "",
  );
}

async function fetchJson(url, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": "agentcore-release-readiness" },
      });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw lastError;
}

try {
  const apiBase = productionApiBase();
  console.log(`[release] checking ${apiBase}`);

  const ready = await fetchJson(`${apiBase}/readyz`);
  if (ready?.status !== "ready" || ready?.database !== true) {
    throw new Error(`backend is not ready: ${JSON.stringify(ready)}`);
  }

  const version = await fetchJson(`${apiBase}/version`);
  if (!version?.version && !version?.semver) {
    throw new Error(
      `backend version response is incomplete: ${JSON.stringify(version)}`,
    );
  }

  console.log(
    `[release] backend ready: version=${version.version ?? version.semver}`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[release] blocked: ${message}`);
  process.exitCode = 1;
}
