import { api } from "@/services/api";

/** Overlay for 工具箱「提示词」: 账号层我的条目.
 *  Not the deployment 图鉴 (`GET /v1/capabilities`). Optional ``folderId``
 *  still exists on the API; this page always writes the account layer.
 */

export interface SkillSlot {
  name: string;
  summary: string;
}

export interface MineSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  version: string;
}

export interface SkillCatalog {
  slots: SkillSlot[];
  mine: MineSkill[];
  folderId: string | null;
  writable: boolean;
}

export const EMPTY_SKILL_CATALOG: SkillCatalog = {
  slots: [],
  mine: [],
  folderId: null,
  writable: true,
};

interface SlotWire {
  name: string;
  summary: string;
}

interface MineWire {
  id: string;
  name: string;
  description: string;
  content: string;
  version: string;
}

interface CatalogWire {
  slots: SlotWire[];
  mine: MineWire[];
  folder_id?: string | null;
  writable?: boolean;
}

function catalogQuery(folderId?: string | null): string {
  return folderId ? `?folder_id=${encodeURIComponent(folderId)}` : "";
}

function toCatalog(w: CatalogWire): SkillCatalog {
  return {
    folderId: w.folder_id ?? null,
    writable: w.writable !== false,
    slots: w.slots.map((slot) => ({
      name: slot.name,
      summary: slot.summary,
    })),
    mine: w.mine.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      content: item.content,
      version: item.version,
    })),
  };
}

export function getSkillCatalog(
  folderId?: string | null,
): Promise<SkillCatalog> {
  return api
    .get<CatalogWire>(`/v1/skill-catalog${catalogQuery(folderId)}`)
    .then(toCatalog);
}

export function composeSkillContent(
  applyMode: "always" | "on_demand",
  description: string,
  body: string,
  offersTools: readonly string[] = [],
): string {
  const desc = description.replace(/\s+/g, " ").trim();
  const apply = applyMode === "always" ? "always" : "on_demand";
  const offers = normalizeOfferTools(offersTools);
  const lines = [`apply: ${apply}`];
  if (desc) lines.push(`description: ${desc}`);
  if (offers.length) lines.push(`offers_tools: ${offers.join(", ")}`);
  return `---\n${lines.join("\n")}\n---\n${body.replace(/^\r?\n/, "")}`;
}

export function composeOnDemandSkillContent(
  description: string,
  body: string,
  offersTools: readonly string[] = [],
): string {
  return composeSkillContent("on_demand", description, body, offersTools);
}

export function skillBodyFromContent(content: string): string {
  const split = splitFrontmatter(content);
  return split ? split.body : content;
}

const OFFER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export function normalizeOfferTools(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const token = raw.trim();
    if (!token || seen.has(token) || !OFFER_TOKEN.test(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export function parseOffersTools(content: string): string[] {
  const split = splitFrontmatter(content);
  if (!split) return [];
  const line = split.fm
    .split(/\r?\n/)
    .find((row) => /^\s*offers_tools\s*:/i.test(row));
  if (!line) return [];
  const raw = line
    .replace(/^\s*offers_tools\s*:\s*/i, "")
    .replace(/\s+#.*$/, "");
  return normalizeOfferTools(raw.split(/[,，、]/));
}

export interface BindableToolOption {
  id: string;
  label: string;
}

export function bindableToolOptions(
  tools: { name: string; resident: boolean; summary?: string }[],
  connectors: { id: string; name: string }[] = [],
): BindableToolOption[] {
  const builtin = tools
    .filter((tool) => !tool.resident)
    .map((tool) => ({
      id: tool.name,
      label: (tool.summary || tool.name).trim() || tool.name,
    }));
  const mcp = connectors
    .filter((server) => server.id.trim())
    .map((server) => ({
      id: server.id,
      label: (server.name || server.id).trim() || server.id,
    }));
  return [...builtin, ...mcp];
}

function splitFrontmatter(
  content: string,
): { fm: string; body: string } | null {
  if (!content.startsWith("---")) return null;
  const close = content.indexOf("\n---", 3);
  if (close < 0) return null;
  return {
    fm: content.slice(4, close),
    body: content.slice(close + 4).replace(/^\r?\n/, ""),
  };
}

export function skillFileName(title: string): string {
  const trimmed = title.trim() || "未命名提示词";
  return trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
}
