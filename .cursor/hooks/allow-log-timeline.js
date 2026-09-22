/**
 * beforeShellExecution: auto-allow a read-only log_timeline.py invocation.
 *
 * Allows stdout flags only (--trace / --messages / --json / --since /
 * --export-dir / --file, plus one trace or conversation id). --pack, --raw,
 * --full, --help, redirects, command substitution, and chaining stay on the
 * normal approval path (permission "ask"). The script basename must be
 * exactly log_timeline.py. Other shell commands never reach this hook.
 *
 * Fail-open: a crash exits non-zero so Cursor keeps its default review.
 * Schema: https://cursor.com/docs/hooks (beforeShellExecution)
 */

"use strict";

const META = /[|&;<>`\r\n$()]/;
const TRACE_ID = /^[0-9a-f]{32}$/i;
const CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PYTHON = /^python3?(\.exe)?$|^py(\.exe)?$/i;

function tokenize(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(command))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

/** True when the command only reads a timeline / message text to stdout. */
function isReadOnlyLogTimeline(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  if (META.test(command)) return false;
  const tokens = tokenize(command.trim());
  const idx = tokens.findIndex((token) => {
    const norm = token.replace(/\\/g, "/");
    const base = norm.slice(norm.lastIndexOf("/") + 1);
    return base === "log_timeline.py";
  });
  if (idx < 0) return false;

  let launcher = tokens.slice(0, idx);
  if (launcher[0] === "uv" && launcher[1] === "run") launcher = launcher.slice(2);
  if (launcher.length !== 1 || !PYTHON.test(launcher[0])) return false;

  const args = tokens.slice(idx + 1);
  let positionals = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json" || arg === "--messages") continue;
    if (arg === "--trace" || arg === "--since" || arg === "--export-dir" || arg === "--file") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) return false;
      if (arg === "--trace" && !TRACE_ID.test(value)) return false;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) return false;
    if (!TRACE_ID.test(arg) && !CONVERSATION_ID.test(arg)) return false;
    positionals += 1;
    if (positionals > 1) return false;
  }
  return true;
}

function decide(command) {
  if (isReadOnlyLogTimeline(command)) return { permission: "allow" };
  return { permission: "ask" };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = raw && raw.trim() ? JSON.parse(raw) : {};
    process.stdout.write(JSON.stringify(decide(payload.command)));
  } catch {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { decide, isReadOnlyLogTimeline };
