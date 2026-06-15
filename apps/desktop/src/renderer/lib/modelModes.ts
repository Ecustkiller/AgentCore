/**
 * 质量档 (model quality modes, D2) — display labels + role/model vocabulary.
 *
 * The backend speaks team roles (`ceo` / `worker_strong` / `worker_economy`) and
 * raw model ids (llm/modes.py); this is the single place the renderer turns them
 * into the 团队语言 the user sees ("CEO 本体 / 主力 worker / 经济 worker") so the
 * internal profile names (`chat` / `agent.strong` / …) never leak into the UI.
 * Pure data — no React / store deps — so both the composer selector and the
 * settings page share one vocabulary.
 */

// Logical model ids (mirror llm/config.py); the operator ceiling decides which
// of these a user may actually pick (catalog.models).
export const MODEL_FLASH = "deepseek-v4-flash";
export const MODEL_PRO = "deepseek-v4-pro";

/** Raw model id → 大众-facing label (product 质量 language, not the raw id). */
const MODEL_LABELS: Record<string, string> = {
  [MODEL_FLASH]: "Flash · 经济",
  [MODEL_PRO]: "Pro · 高质量",
};

/** A one-line cost hint shown beside a model option; empty for the base tier. */
const MODEL_NOTES: Record<string, string> = {
  [MODEL_PRO]: "约 3× 成本",
};

export function modelLabel(id: string): string {
  return MODEL_LABELS[id] ?? id;
}

export function modelNote(id: string): string {
  return MODEL_NOTES[id] ?? "";
}

/** Team role key → label + what it does (团队语言, never the internal profile). */
export const ROLE_LABELS: Record<string, string> = {
  ceo: "CEO 本体",
  worker_strong: "主力 worker",
  worker_economy: "经济 worker",
};

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  ceo: "与你直接对话、统筹全局的主 Agent",
  worker_strong: "承担高质量 / 复杂子任务的成员",
  worker_economy: "处理简单子任务的成员（锁定经济模型）",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/** Built-in preset key → label + description (read-only, code-defined). */
export const PRESET_LABELS: Record<string, string> = {
  economy: "经济档",
  quality: "高质量档",
};

export const PRESET_DESCRIPTIONS: Record<string, string> = {
  economy: "全程使用经济模型，最省成本",
  quality: "CEO 本体与主力 worker 用高质量模型",
};

export function presetLabel(key: string): string {
  return PRESET_LABELS[key] ?? key;
}

/**
 * A mode ref (preset key or custom-mode id) → its display name. Presets win;
 * then the user's custom modes by id; an unknown ref falls back to the raw value
 * (a stale selection resolves to economy server-side, so this is display-only).
 */
export function modeRefLabel(
  ref: string,
  custom: { id: string; name: string }[],
): string {
  if (ref in PRESET_LABELS) return PRESET_LABELS[ref];
  return custom.find((m) => m.id === ref)?.name ?? ref;
}

// --- Full team picture + cost (settings page) --------------------------------

/** Team-role display order, mirrors backend `_ROLE_ORDER` (CEO → 主力 → 经济). */
export const TEAM_ROLE_ORDER = [
  "ceo",
  "worker_strong",
  "worker_economy",
] as const;

/** Roles pinned to a fixed model (display only). 经济 worker 锁定 Flash（决策：锁 Flash）。 */
export const LOCKED_ROLE_MODELS: Record<string, string> = {
  worker_economy: MODEL_FLASH,
};

export function isRoleLocked(role: string): boolean {
  return role in LOCKED_ROLE_MODELS;
}

/**
 * The model a role effectively runs under a mode's assignments: a locked role is
 * pinned (经济 worker → Flash); a configurable role uses its override or the base
 * 经济 model. Lets the settings page render the whole team from assignments alone
 * (no catalog dependency), matching the backend's resolve semantics.
 */
export function effectiveRoleModel(
  role: string,
  assignments: Record<string, string>,
): string {
  if (role in LOCKED_ROLE_MODELS) return LOCKED_ROLE_MODELS[role];
  return assignments[role] ?? MODEL_FLASH;
}

/** Roles whose model the user may actually swap (mirrors backend CONFIGURABLE_ROLES). */
const CONFIGURABLE_ROLES = ["ceo", "worker_strong"] as const;

export type CostLevel = "base" | "mid" | "high";

/**
 * A mode's relative cost, derived from how many configurable roles run the costly
 * tier (Pro ≈ 3×). 经济 worker is excluded (locked Flash). Qualitative on purpose —
 * actual spend depends on per-role token mix, so we surface a tier, not a fake ×.
 */
export function modeCostTier(assignments: Record<string, string>): {
  level: CostLevel;
  label: string;
} {
  const pro = CONFIGURABLE_ROLES.filter(
    (r) => assignments[r] === MODEL_PRO,
  ).length;
  if (pro === 0) return { level: "base", label: "基准成本" };
  if (pro >= CONFIGURABLE_ROLES.length)
    return { level: "high", label: "较高成本" };
  return { level: "mid", label: "中等成本" };
}
