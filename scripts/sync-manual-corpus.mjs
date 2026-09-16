#!/usr/bin/env node
/**
 * Mirror desktop manual content/*.ts → server product_help_corpus.json.
 *
 * Canonical SoT: apps/desktop/.../toolbox/manual/content/*.ts
 *   → apps/server/agentcore/runtime/skills/product_help_corpus.json
 *
 * Usage:
 *   pnpm sync:manual-corpus
 *   pnpm sync:manual-corpus:check
 *
 * Wired: package.json; release:gate desktop 段；CI frontend job。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(ROOT, "apps", "desktop");
const check = process.argv.includes("--check");
const args = ["exec", "tsx", "scripts/export-manual-corpus.ts"];
if (check) args.push("--check");

const result = spawnSync("pnpm", args, {
  cwd: desktop,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status === null ? 1 : result.status);
