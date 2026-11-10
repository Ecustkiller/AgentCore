#!/usr/bin/env node
/**
 * pre-commit local hook: ruff check on staged apps/server Python files.
 * Uses the repo's uv + apps/server pyproject (no separate pre-commit ruff env).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const serverDir = path.join(repoRoot, "apps/server");
const files = process.argv
  .slice(2)
  .map((f) => f.replace(/\\/g, "/"))
  .filter((f) => f.startsWith("apps/server/") && /\.pyi?$/.test(f))
  .map((f) => path.relative(serverDir, path.resolve(repoRoot, f)));

if (files.length === 0) process.exit(0);

// Explicit file lists bypass extend-exclude unless --force-exclude is set.
const result = spawnSync(
  "uv",
  ["run", "ruff", "check", "--config", "pyproject.toml", "--force-exclude", ...files],
  {
    cwd: serverDir,
    stdio: "inherit",
    shell: true,
    env: process.env,
  },
);

if (result.error) {
  console.error("[pre-commit-ruff] failed to spawn uv/ruff:", result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
