import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  WORKBUDDY_IMPORT_CHANNELS,
  type WorkBuddyMcpCandidate,
  type WorkBuddyScanResult,
  type WorkBuddySkillCandidate,
  type WorkBuddySkillText,
} from "@shared/workbuddy-import-contract";
import { app, ipcMain } from "electron";
import { remoteMcpEnabled } from "./mcp-remote";

const MAX_SKILL_DIRS = 2000;
const MAX_MCP_FILES = 40;
const SECRET_KEY_RE = /(token|key|secret|password|authorization|credential)/i;
const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;
const SECRET_VALUE_RE =
  /(bearer\s+|sk-[a-z0-9_-]{12,}|(?:token|key|secret|password)=)/i;
const skillPathById = new Map<string, string>();

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha1").update(value).digest("hex").slice(0, 16)}`;
}

function frontmatter(content: string): {
  name: string;
  description: string;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { name: "", description: "", body: content };
  }
  const close = content.indexOf("\n---", 3);
  if (close < 0) return { name: "", description: "", body: content };
  const raw = content.slice(3, close).replace(/\r/g, "");
  const lines = raw.split("\n");
  let name = "";
  let description = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const nameMatch = line.match(/^name:\s*(.*)$/);
    if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) {
      description = descMatch[1].trim().replace(/^["']|["']$/g, "");
      if (description === ">" || description === "|") {
        const folded: string[] = [];
        for (let j = i + 1; j < lines.length; j += 1) {
          if (!/^\s+/.test(lines[j])) break;
          folded.push(lines[j].trim());
        }
        description = folded.join(" ").trim();
      }
    }
  }
  return {
    name,
    description,
    body: content.slice(close + 4).replace(/^\r?\n+/, ""),
  };
}

function countResources(root: string): number {
  let count = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || count >= 500) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "SKILL.md" || entry.name === "config.json") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else count += 1;
    }
  };
  walk(root, 0);
  return count;
}

function importableDirs(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (out.length >= MAX_SKILL_DIRS) break;
    if (entry.name.startsWith(".") || entry.name === "skills-index.json")
      continue;
    const path = join(root, entry.name);
    try {
      if (!statSync(path).isDirectory()) continue;
      if (existsSync(join(path, "SKILL.md"))) out.push(path);
    } catch {
      // Broken symlink / inaccessible skill is skipped without blocking the scan.
    }
  }
  return out;
}

function skillCandidate(
  path: string,
  source: WorkBuddySkillCandidate["source"],
): WorkBuddySkillCandidate | null {
  try {
    const folder = basename(path);
    const content = readFileSync(join(path, "SKILL.md"), "utf8");
    const parsed = frontmatter(content);
    const configPath = join(path, "config.json");
    const configKeys: string[] = [];
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<
        string,
        unknown
      >;
      configKeys.push(
        ...Object.keys(raw).filter((key) => SECRET_KEY_RE.test(key)),
      );
    }
    const id = stableId("wbskill", `${source}:${path}`);
    skillPathById.set(id, path);
    return {
      id,
      name: parsed.name || folder.replace(/__skillhub$/i, ""),
      description: parsed.description,
      source,
      folder,
      skillhub:
        /__skillhub$/i.test(folder) || existsSync(join(path, "config.json")),
      resourceCount: countResources(path),
      configKeys,
    };
  } catch {
    return null;
  }
}

export function readWorkBuddySkillBodies(
  ids: readonly string[],
): WorkBuddySkillText[] {
  const out: WorkBuddySkillText[] = [];
  for (const id of new Set(ids).values()) {
    const path = skillPathById.get(id);
    if (!path) continue;
    try {
      const content = readFileSync(join(path, "SKILL.md"), "utf8");
      out.push({ id, body: frontmatter(content).body });
    } catch {
      // The source may disappear between scan and import; omit it explicitly.
    }
  }
  return out;
}

function collectEnabledConnectorNames(base: string): Set<string> {
  const names = new Set<string>();
  const connectors = join(base, "connectors");
  if (!existsSync(connectors)) return names;
  for (const entry of readdirSync(connectors, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statePath = join(connectors, entry.name, "connector-states.v3.json");
    if (!existsSync(statePath)) continue;
    try {
      const raw = JSON.parse(readFileSync(statePath, "utf8")) as {
        enabled?: unknown;
      };
      if (Array.isArray(raw.enabled)) {
        for (const name of raw.enabled) {
          if (typeof name === "string") names.add(name);
        }
      }
    } catch {
      // A corrupt WorkBuddy state file only makes that connector undiscoverable.
    }
  }
  return names;
}

function mcpConfigPaths(base: string): string[] {
  const out: string[] = [];
  const roots = [
    join(base, ".mcp.json"),
    join(base, "remote-package", "remote", ".mcp.json"),
    join(base, "connectors", "default", "mcp.json"),
  ];
  for (const path of roots) if (existsSync(path)) out.push(path);
  const projects = join(base, "project-resources");
  if (existsSync(projects)) {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (out.length >= MAX_MCP_FILES) break;
      if (!entry.isDirectory()) continue;
      const path = join(projects, entry.name, "mcp.json");
      if (existsSync(path)) out.push(path);
    }
  }
  return out.slice(0, MAX_MCP_FILES);
}

function mcpCandidates(
  base: string,
  source: WorkBuddyMcpCandidate["source"],
): WorkBuddyMcpCandidate[] {
  const enabled = collectEnabledConnectorNames(base);
  const out: WorkBuddyMcpCandidate[] = [];
  for (const file of mcpConfigPaths(base)) {
    const connectorCatalog =
      file.includes(`${join(base, "connectors")}`) ||
      file.includes("/connectors/");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const servers =
      raw && typeof raw === "object" && "mcpServers" in raw
        ? (raw as { mcpServers?: unknown }).mcpServers
        : null;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      continue;
    }
    for (const [rawName, value] of Object.entries(
      servers as Record<string, unknown>,
    )) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const name = rawName.replace(/^connector:/, "");
      if (name === "connector-proxy") continue;
      const cfg = value as Record<string, unknown>;
      if (connectorCatalog && enabled.size > 0 && !enabled.has(name)) continue;
      if (cfg.disabled === true && !enabled.has(name)) continue;
      let command = typeof cfg.command === "string" ? cfg.command.trim() : "";
      const rawUrl = typeof cfg.url === "string" ? cfg.url.trim() : "";
      const type = String(cfg.type || "").toLowerCase();
      const envSource =
        cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)
          ? (cfg.env as Record<string, unknown>)
          : {};
      const env: Record<string, string> = {};
      const credentialKeys: string[] = [];
      if (command.includes("${") || SECRET_VALUE_RE.test(command)) {
        credentialKeys.push("command");
        command = "";
      }
      for (const [key, rawValue] of Object.entries(envSource)) {
        const valueText = String(rawValue || "");
        if (SECRET_KEY_RE.test(key) || PLACEHOLDER_RE.test(valueText)) {
          credentialKeys.push(key);
          env[key] = "";
        } else if (["NO_PROXY", "npm_config_registry"].includes(key)) {
          env[key] = valueText;
        } else {
          credentialKeys.push(key);
          env[key] = "";
        }
        PLACEHOLDER_RE.lastIndex = 0;
      }
      const args = Array.isArray(cfg.args)
        ? cfg.args.map((raw) => {
            const arg = String(raw);
            if (arg.includes("${") || SECRET_VALUE_RE.test(arg)) {
              credentialKeys.push("args");
              return "";
            }
            return arg;
          })
        : [];
      let url = rawUrl;
      if (rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          for (const [key, value] of parsed.searchParams.entries()) {
            if (
              SECRET_KEY_RE.test(key) ||
              value.includes("${") ||
              SECRET_VALUE_RE.test(value)
            ) {
              parsed.searchParams.set(key, "");
              credentialKeys.push(`url.${key}`);
            }
          }
          url = parsed.toString();
        } catch {
          url = "";
          credentialKeys.push("url");
        }
      }
      const transport =
        command && (!url || type === "stdio")
          ? "stdio"
          : type === "sse"
            ? "unsupported"
            : "http";
      let importable = transport === "stdio" && !!command;
      let reason = "";
      if (transport === "unsupported") {
        reason = "Nexus 不支持旧式 SSE 运输";
      } else if (transport === "http") {
        importable = remoteMcpEnabled() && !!url;
        reason = importable
          ? "HTTP 配置需重新填写鉴权信息"
          : "远程 HTTP MCP 默认关闭；需启用实验开关并重启";
      } else if (!command) {
        reason = "stdio 配置缺少 command";
      }
      out.push({
        id: stableId("wbmcp", `${source}:${rawName}`),
        name,
        source,
        transport,
        command,
        args,
        env,
        credentialKeys: [...new Set(credentialKeys)],
        ...(url ? { url } : {}),
        importable,
        ...(reason ? { reason } : {}),
      });
    }
  }
  return out;
}

export function scanWorkBuddy(home: string): WorkBuddyScanResult {
  try {
    const definitions = [
      { path: join(home, ".workbuddy"), source: "workbuddy" as const },
      { path: join(home, ".workbuddyvpc"), source: "workbuddyvpc" as const },
    ].filter((entry) => existsSync(entry.path));
    const warnings: string[] = [];
    const skills: WorkBuddySkillCandidate[] = [];
    const mcpServers: WorkBuddyMcpCandidate[] = [];
    for (const definition of definitions) {
      const root = join(definition.path, "skills");
      for (const dir of importableDirs(root)) {
        const candidate = skillCandidate(dir, definition.source);
        if (candidate) skills.push(candidate);
        else warnings.push(`无法读取 ${relative(home, dir)}/SKILL.md`);
      }
      mcpServers.push(...mcpCandidates(definition.path, definition.source));
    }
    const seen = new Set<string>();
    return {
      ok: true,
      roots: definitions.map((entry) => relative(home, entry.path)),
      skills: skills.filter((skill) => {
        const key = `${skill.source}:${skill.folder}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
      mcpServers: mcpServers.filter((server) => {
        const key = `${server.source}:${server.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
      warnings: warnings.slice(0, 50),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "WorkBuddyScanError",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function registerWorkBuddyImportIpc(): void {
  ipcMain.handle(WORKBUDDY_IMPORT_CHANNELS.scan, async () =>
    scanWorkBuddy(app.getPath("home")),
  );
  ipcMain.handle(
    WORKBUDDY_IMPORT_CHANNELS.readSkills,
    async (_event, ids: unknown) =>
      readWorkBuddySkillBodies(
        Array.isArray(ids)
          ? ids.filter((id): id is string => typeof id === "string")
          : [],
      ),
  );
}
