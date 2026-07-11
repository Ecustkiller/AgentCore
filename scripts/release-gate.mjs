#!/usr/bin/env node
/**
 * Local release gate — isomorphic with `.github/workflows/ci.yml`, plus desktop
 * gaps (typecheck + conformance) that CI historically omitted.
 *
 *   pnpm release:gate
 *
 * Any non-zero step fails the whole gate. Backend uses unit pytest
 * (`--ignore=tests/integration`) for local runnability; CI still runs full
 * pytest with Postgres.
 *
 * Contract drift (local): regen twice and require idempotence. Unlike CI's clean
 * checkout + `git diff` vs HEAD, a local WIP tree may already contain intentional
 * uncommitted artifact updates — those must still be committed before push; this
 * gate only proves regen is stable.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "apps", "server");

const CONTRACT_DRIFT_PATHS = [
  "apps/server/openapi.json",
  "packages/contract-rest-types/src/api.generated.ts",
  "packages/contract-types/src/eventTypes.generated.ts",
  "packages/contract-types/src/events.generated.ts",
  "packages/protocol-conformance/fixtures",
];

function run(label, cmd, args, opts = {}) {
  console.log(`\n→ ${label}`);
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: "inherit",
    env: { ...process.env, ...opts.env },
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`\n✗ release:gate FAILED — ${label}`);
    process.exit(result.status ?? 1);
  }
}

/** Run a long noisy command; keep full log on disk, only stream a short tail on failure.
 *
 * Inheriting megabytes of sim/LLM info logs into the agent terminal is slow enough on
 * Windows to trip pytest-timeout (60s) even when the test itself is fine.
 */
function runLogged(label, cmd, args, opts = {}) {
  console.log(`\n→ ${label}`);
  const logDir = join(tmpdir(), "agentcore-release-gate");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${label.replace(/[^\w.-]+/g, "_")}.log`);
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(logPath, out, "utf8");
  // Progress crumbs for the live terminal (last non-empty lines of pytest -q).
  const crumbs = out
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.includes("llm.request") && !l.includes("llm.response"));
  for (const line of crumbs.slice(-8)) console.log(line);
  console.log(`  (full log: ${logPath})`);
  if (result.status !== 0) {
    console.error(`\n✗ release:gate FAILED — ${label}`);
    console.error("--- log tail ---");
    console.error(crumbs.slice(-40).join("\n"));
    process.exit(result.status ?? 1);
  }
}

function section(title) {
  console.log(`\n══ ${title} ══`);
}

function listFiles(relPath) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  if (st.isFile()) return [abs];
  const out = [];
  for (const name of readdirSync(abs)) {
    const child = join(abs, name);
    if (statSync(child).isDirectory()) {
      out.push(...listFiles(join(relPath, name)));
    } else {
      out.push(child);
    }
  }
  return out;
}

function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(absPath);
    s.on("data", (chunk) => h.update(chunk));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

async function fingerprintContracts() {
  const files = CONTRACT_DRIFT_PATHS.flatMap(listFiles).sort();
  const parts = [];
  for (const f of files) {
    parts.push(`${f}\0${await hashFile(f)}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function regenContracts() {
  run("gen-types", "node", ["scripts/gen-types.mjs"]);
  run("conformance export", "uv", ["run", "python", "-m", "agentcore.conformance.export"], {
    cwd: SERVER,
  });
}

async function assertContractIdempotent() {
  console.log("\n→ contract regen idempotence");
  const first = await fingerprintContracts();
  regenContracts();
  const second = await fingerprintContracts();
  if (first !== second) {
    console.error("\n✗ release:gate FAILED — contract regen not idempotent");
    console.error("  First and second regen produced different artifacts.");
    process.exit(1);
  }
  const porcelain = spawnSync(
    "git",
    ["status", "--porcelain", "--", ...CONTRACT_DRIFT_PATHS],
    { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" },
  );
  const dirty = (porcelain.stdout || "").trim();
  if (dirty) {
    console.log(
      "  note: contract artifacts differ from HEAD — include them in the release commit:",
    );
    console.log(
      dirty
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  } else {
    console.log("  contract artifacts match HEAD");
  }
}

async function main() {
  console.log("release:gate — local CI isomorphic gate");

  section("backend");
  run("ruff check", "uv", ["run", "ruff", "check", "."], { cwd: SERVER });
  runLogged(
    "pytest (unit)",
    "uv",
    ["run", "pytest", "--ignore=tests/integration", "--tb=short", "-q"],
    {
      cwd: SERVER,
      env: { LOG_LEVEL: "WARNING" },
    },
  );

  section("contracts");
  regenContracts();
  run("story-packs check", "pnpm", ["gen:story-packs:check"]);
  await assertContractIdempotent();

  section("desktop");
  run("desktop lint", "pnpm", ["--filter", "agentcore-desktop", "lint"]);
  run("desktop typecheck", "pnpm", ["--filter", "agentcore-desktop", "typecheck"]);
  run("desktop test", "pnpm", [
    "--filter",
    "agentcore-desktop",
    "exec",
    "vitest",
    "run",
  ]);
  run("desktop conformance", "pnpm", ["--filter", "agentcore-desktop", "conformance"]);
  run("desktop shoot", "pnpm", ["--filter", "agentcore-desktop", "shoot"], {
    env: { SHOOT_FRAMES: "3" },
  });
  run("desktop smoke:webapp:ci", "pnpm", [
    "--filter",
    "agentcore-desktop",
    "smoke:webapp:ci",
  ]);

  section("mobile");
  run("mobile lint", "pnpm", ["--filter", "agentcore-mobile", "lint"]);
  run("mobile typecheck", "pnpm", ["--filter", "agentcore-mobile", "typecheck"]);
  run("mobile conformance", "pnpm", ["--filter", "agentcore-mobile", "conformance"]);

  section("admin");
  run("admin typecheck", "pnpm", ["--filter", "agentcore-admin", "typecheck"]);

  console.log("\n✓ release:gate passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
