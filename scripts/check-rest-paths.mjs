#!/usr/bin/env node
/**
 * REST 路径漂移门禁（最后修订 2026-11-04）。
 *
 * `packages/contract-rest-types/src/paths.generated.ts` 由 openapi.json 生成，
 * 但 renderer / admin 的 services 里仍手写 `/v1/...` 字面量。`restPath()` 的
 * 参数是生成模板的字面量联合类型，用它的地方编译期就有保障；没用它的地方
 * 只有运行时才会 404。这个脚本把后一类也纳入检查：把源码里的路径归一化
 * （`${id}` → `{param}`、去掉 query）后与生成模板比对，不匹配的即为漂移。
 *
 * 既有违规不假装不存在：列在 `scripts/rest-paths-baseline.json`，只允许减少，
 * 不允许新增。修好一条就把它从基线里删掉，ratchet 自然收紧。
 *
 * 用法：node scripts/check-rest-paths.mjs [--report]
 *   --report 只打印统计，不因漂移失败（用于生成初始基线）。
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const GENERATED = join(
  ROOT,
  "packages/contract-rest-types/src/paths.generated.ts",
);
const BASELINE = join(ROOT, "scripts/rest-paths-baseline.json");
const SCAN_DIRS = [
  "apps/desktop/src/renderer/services",
  "apps/desktop/src/renderer/lib",
  "apps/admin/src/services",
];
const REPORT_ONLY = process.argv.includes("--report");

function collectFiles(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs)) {
    const p = join(abs, entry);
    // 测试里的 mock URL（/v1/thing、写死 id 的请求路径）不是生产契约，排除。
    if (statSync(p).isDirectory()) {
      if (entry !== "__tests__") out.push(...collectFiles(relative(ROOT, p)));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

function generatedTemplates() {
  const text = readFileSync(GENERATED, "utf8");
  const start = text.indexOf("REST_PATH_TEMPLATES = [");
  const end = text.indexOf("] as const;", start);
  if (start < 0 || end < 0) throw new Error("cannot locate REST_PATH_TEMPLATES");
  const body = text.slice(start, end);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** `{doc_id}` → `{param}`；去掉 query 与尾斜杠。 */
function normalize(path) {
  let out = path.split("?")[0].replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, "{param}");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

const templates = new Set(generatedTemplates().map(normalize));
const templateList = [...templates];
const found = new Map();

/** 含 `${...}` 的路径只比静态前缀：模板必须在同一分段边界上继续。 */
function prefixMatches(prefix) {
  const clean = normalize(prefix);
  if (clean === "" || clean === "/v1") return true;
  return templateList.some(
    (t) => t === clean || t.startsWith(`${clean}/{`) || t.startsWith(`${clean}/`),
  );
}

for (const dir of SCAN_DIRS) {
  for (const file of collectFiles(dir)) {
    const text = readFileSync(file, "utf8");
    // 注释/文档里的示例路径（`/v1/users/<id>/avatar`、`/workspace/...`）不是调用点。
    const code = text
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");
    // 匹配 "/v1/..." 与 `/v1/...`（含模板插值），不跨行。
    for (const m of code.matchAll(/["'`](\/v1\/[^"'`\n]*)["'`]/g)) {
      const raw = m[1];
      // `startsWith("/v1/auth/")` 这类是前缀判断，不是一条完整路径。
      if (raw.endsWith("/")) continue;
      if (raw.includes("${")) {
        // 只取插值之前的静态部分；`?` 之后全是 query，不算路径。
        if (prefixMatches(raw.slice(0, raw.indexOf("${")))) continue;
      } else if (templates.has(normalize(raw))) {
        continue;
      }
      const normalized = normalize(raw.includes("${") ? raw.slice(0, raw.indexOf("${")) : raw);
      const key = `${relative(ROOT, file)}|${normalized}`;
      if (!found.has(key)) found.set(key, { file: relative(ROOT, file), path: normalized });
    }
  }
}

const drift = [...found.values()].sort((a, b) =>
  `${a.file}${a.path}`.localeCompare(`${b.file}${b.path}`),
);
const baseline = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, "utf8"))
  : [];
const baselineKeys = new Set(baseline.map((b) => `${b.file}|${b.path}`));
const nowKeys = new Set(drift.map((d) => `${d.file}|${d.path}`));
const added = drift.filter((d) => !baselineKeys.has(`${d.file}|${d.path}`));
const fixed = baseline.filter((b) => !nowKeys.has(`${b.file}|${b.path}`));

console.log(
  `check-rest-paths: ${templates.size} templates, ${drift.length} drift entries, ` +
    `${baseline.length} baselined, ${added.length} new, ${fixed.length} fixed`,
);
if (added.length) {
  console.error("\nNew unmatched REST paths (use restPath() from the generated contract):");
  for (const d of added) console.error(`  + ${d.file}  ${d.path}`);
  // 绝不在这里自动扩基线，否则门禁会被第一次失败自己放行。
}
if (fixed.length && !REPORT_ONLY) {
  console.log("\nBaselined paths that are now clean — remove them to tighten the ratchet:");
  for (const b of fixed) console.log(`  - ${b.file}  ${b.path}`);
}
if (REPORT_ONLY) {
  writeBaseline();
  console.log(`\nWrote baseline with ${drift.length} entries: ${relative(ROOT, BASELINE)}`);
}

function writeBaseline() {
  writeFileSync(BASELINE, `${JSON.stringify(drift, null, 2)}\n`);
}

if (!REPORT_ONLY && added.length) process.exit(1);
