#!/usr/bin/env node
/**
 * Shared UI token lint gate (color-tokens.mdc / desktop-layout.mdc).
 *
 * Usage:
 *   node scripts/check-ui-tokens.mjs --src apps/desktop/src/renderer
 *
 * Desktop also gates raw CSS font-size/border-radius px bypasses
 * (A-phase: StageCard-style second skins). Desktop L2 (`components/ui/`,
 * not `__tests__`) additionally blocks raw shadow-sm/md/lg and `focus:ring`
 * (use elevation aliases + focus-visible).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** @type {{ id: string; re: RegExp; hint: string }[]} */
const BASE_RULES = [
  {
    id: "rounded-md",
    re: /\brounded-md\b/,
    hint: "use rounded-lg (small) or rounded-xl (large)",
  },
  {
    id: "rounded-sm",
    re: /\brounded-sm\b/,
    hint: "use rounded-lg",
  },
  {
    id: "rounded-2xl",
    re: /\brounded-2xl\b/,
    hint: "use rounded-xl (max large radius)",
  },
  {
    id: "custom-font-px",
    re: /\btext-\[(?:10|11|13)px\]/,
    hint: "use text-xs (12px) or text-sm (14px)",
  },
  {
    id: "tailwind-palette",
    re: /\b(?:bg|text|border|ring|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+/,
    hint: "use semantic tokens (primary, success, warning, …)",
  },
  {
    id: "arbitrary-hex",
    re: /\b(?:bg|text|border)-\[#[0-9a-fA-F]+\]/,
    hint: "use semantic CSS variables / Tailwind token classes",
  },
];

/** L2 only — business pages stay 触达即收编. */
const L2_RULES = [
  {
    id: "shadow-raw",
    re: /\bshadow-(?:sm|md|lg|xl|2xl)\b/,
    hint: "L2: use shadow-raised / shadow-overlay / shadow-modal",
  },
  {
    id: "focus-ring",
    re: /\bfocus:ring(?:-|\b)/,
    hint: "L2: use focus-visible:ring-2 (not focus:ring)",
  },
];

/** Allowed CSS border-radius px (desktop-layout 3-tier + pill). */
const ALLOWED_RADIUS_PX = new Set([8, 12, 9999]);

function isDesktopL2(file) {
  const norm = file.replace(/\\/g, "/");
  return (
    norm.includes("/components/ui/") && !norm.includes("/components/ui/__tests__/")
  );
}

/**
 * Desktop-only CSS bypass rules (raw px that escape Tailwind class lint).
 * @type {{ id: string; hint: string; match: (line: string) => boolean }[]}
 */
const DESKTOP_CSS_RULES = [
  {
    id: "css-font-size-px",
    hint: "CSS font-size px bypass — use Tailwind text-xs/sm/base/xl (or rem)",
    match(line) {
      return /font-size\s*:\s*\d+(?:\.\d+)?px\b/.test(line);
    },
  },
  {
    id: "css-border-radius-px",
    hint: "CSS border-radius px must be 8 (lg), 12 (xl), or 9999 (pill)",
    match(line) {
      if (!/border-radius\s*:/.test(line)) return false;
      const re = /(\d+(?:\.\d+)?)px\b/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (!ALLOWED_RADIUS_PX.has(Number(m[1]))) return true;
      }
      return false;
    },
  },
];

/** Action-menu width lives on L2 primitive only (UI-Pattern 动作菜单宽度). */
const ACTION_MENU_PRIMITIVE =
  /(?:^|\/)components\/ui\/(?:dropdown-menu|context-menu)\.tsx$/;
const ACTION_MENU_WIDTH_RE =
  /\b(?:min-w-|max-w-|(?<![a-z-])w-(?:\d+|px|max|min|fit|screen|auto|full|svw|lvw|dvw|\[))/;

function stripJsxComparisons(s) {
  return s.replace(/=>/g, " ").replace(/[<>]=/g, " ");
}

function collectJsxOpenTag(lines, start) {
  let buf = lines[start];
  if (stripJsxComparisons(buf).includes(">")) return buf;
  for (let j = start + 1; j < lines.length && j - start < 16; j++) {
    buf += `\n${lines[j]}`;
    if (stripJsxComparisons(buf).includes(">")) return buf;
  }
  return buf;
}

function scanActionMenuWidth(relativeFile, lines) {
  const norm = relativeFile.replace(/\\/g, "/");
  if (ACTION_MENU_PRIMITIVE.test(norm)) return [];
  if (!/\.(tsx|ts)$/.test(norm)) return [];
  /** @type {{ line: number; text: string }[]} */
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/<(Dropdown|Context)MenuContent\b/.test(lines[i])) continue;
    const chunk = collectJsxOpenTag(lines, i);
    if (ACTION_MENU_WIDTH_RE.test(chunk)) {
      hits.push({
        line: i + 1,
        text: lines[i].trim().slice(0, 120),
      });
    }
  }
  return hits;
}

function parseArgs(argv) {
  let src = "";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--src" && argv[i + 1]) {
      src = argv[++i];
    }
  }
  if (!src) {
    console.error("usage: check-ui-tokens.mjs --src <directory>");
    process.exit(2);
  }
  return { src, srcDir: join(ROOT, src) };
}

async function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === "node_modules" || name.name === "out" || name.name === "dist") continue;
      out.push(...(await walk(p)));
    } else if (/\.(tsx|ts|css)$/.test(name.name)) {
      out.push(p);
    }
  }
  return out;
}

const { src, srcDir } = parseArgs(process.argv);
const isDesktop = /(^|[/\\])desktop([/\\]|$)/.test(src.replace(/\\/g, "/"));

/** @type {{ file: string; line: number; rule: string; hint: string; text: string }[]} */
const violations = [];

for (const file of await walk(srcDir)) {
  const content = await readFile(file, "utf8");
  const lines = content.split("\n");
  const isCss = file.endsWith(".css");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of BASE_RULES) {
      if (rule.re.test(line)) {
        violations.push({
          file: relative(ROOT, file),
          line: i + 1,
          rule: rule.id,
          hint: rule.hint,
          text: line.trim().slice(0, 120),
        });
      }
    }
    if (isDesktop && isCss) {
      for (const rule of DESKTOP_CSS_RULES) {
        if (rule.match(line)) {
          violations.push({
            file: relative(ROOT, file),
            line: i + 1,
            rule: rule.id,
            hint: rule.hint,
            text: line.trim().slice(0, 120),
          });
        }
      }
    }
    if (isDesktop && isDesktopL2(file)) {
      for (const rule of L2_RULES) {
        if (rule.re.test(line)) {
          violations.push({
            file: relative(ROOT, file),
            line: i + 1,
            rule: rule.id,
            hint: rule.hint,
            text: line.trim().slice(0, 120),
          });
        }
      }
    }
  }
  if (isDesktop) {
    for (const hit of scanActionMenuWidth(relative(ROOT, file), lines)) {
      violations.push({
        file: relative(ROOT, file),
        line: hit.line,
        rule: "action-menu-width",
        hint: "action menus hug L2 primitive (min-w-36 max-w-64); do not set min-w/max-w/w on DropdownMenuContent / ContextMenuContent",
        text: hit.text,
      });
    }
  }
}

if (violations.length === 0) {
  console.log(`check-ui-tokens: OK (${relative(ROOT, srcDir)})`);
  process.exit(0);
}

console.error(`check-ui-tokens: ${violations.length} violation(s)\n`);
for (const v of violations) {
  console.error(`${v.file}:${v.line} [${v.rule}] ${v.hint}`);
  console.error(`  ${v.text}\n`);
}
process.exit(1);
