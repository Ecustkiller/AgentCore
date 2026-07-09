import type { FileSource } from "@/lib/fileSource";

/** Mirror server `project_profile._detect_js_run_commands` (best-effort). */
function detectJsRunCommands(content: string, pm: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const scripts = (data as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return [];
  const commands: string[] = [];
  for (const name of ["start", "dev"] as const) {
    if (name in (scripts as Record<string, unknown>)) {
      commands.push(pm === "yarn" ? `yarn ${name}` : `${pm} run ${name}`);
    }
  }
  return commands;
}

function jsPackageManager(content: string): string {
  if (content.includes('"packageManager"') && content.includes("pnpm"))
    return "pnpm";
  if (content.includes('"packageManager"') && content.includes("yarn"))
    return "yarn";
  return "npm";
}

async function readTextFile(
  source: FileSource,
  path: string,
): Promise<string | null> {
  try {
    const preview = await source.read(path);
    if (preview.kind !== "text" || preview.truncated) return null;
    return preview.text;
  } catch {
    return null;
  }
}

/**
 * Best-effort dev/start commands from `package.json` / `pyproject.toml` in the
 * workspace root — aligned with server `detect_project_profile` run_commands.
 */
export async function detectProjectRunCommands(
  source: FileSource,
): Promise<string[]> {
  const commands: string[] = [];

  const pkg = await readTextFile(source, "package.json");
  if (pkg) {
    commands.push(...detectJsRunCommands(pkg, jsPackageManager(pkg)));
  }

  const pyproject = await readTextFile(source, "pyproject.toml");
  if (pyproject?.includes("[project]")) {
    const hasUv = pyproject.includes("[tool.uv]") || pyproject.includes("uv");
    const pm = hasUv ? "uv" : "pip";
    const match = pyproject.match(
      /\[project\.scripts\]\s*([\s\S]*?)(?:\n\[|$)/,
    );
    if (match) {
      const first = match[1]?.match(/^\s*([^\s=]+)\s*=/m);
      if (first?.[1]) commands.push(`${pm} run ${first[1]}`);
    }
  }

  return [...new Set(commands)].slice(0, 3);
}
