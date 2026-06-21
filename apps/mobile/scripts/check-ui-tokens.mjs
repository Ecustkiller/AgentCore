#!/usr/bin/env node
/** Mobile UI token gate — same rules as desktop (color-tokens.mdc). */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");

const RULES = [
  { id: "rounded-md", re: /\brounded-md\b/, hint: "use rounded-lg" },
  { id: "rounded-sm", re: /\brounded-sm\b/, hint: "use rounded-lg" },
  {
    id: "custom-font-px",
    re: /\btext-\[(?:10|11|13)px\]/,
    hint: "use text-xs or text-sm",
  },
  {
    id: "tailwind-palette",
    re: /\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+/,
    hint: "use semantic CSS variables",
  },
];

async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === "node_modules" || name.name === "dist") continue;
      out.push(...(await walk(p)));
    } else if (/\.(tsx|ts|css)$/.test(name.name)) {
      out.push(p);
    }
  }
  return out;
}

const violations = [];
for (const file of await walk(SRC)) {
  const lines = (await readFile(file, "utf8")).split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (rule.re.test(lines[i])) {
        violations.push({
          file: relative(ROOT, file),
          line: i + 1,
          rule: rule.id,
          hint: rule.hint,
          text: lines[i].trim().slice(0, 120),
        });
      }
    }
  }
}

if (violations.length === 0) {
  console.log("check-ui-tokens: OK");
  process.exit(0);
}
console.error(`check-ui-tokens: ${violations.length} violation(s)\n`);
for (const v of violations) {
  console.error(`${v.file}:${v.line} [${v.rule}] ${v.hint}`);
  console.error(`  ${v.text}\n`);
}
process.exit(1);
