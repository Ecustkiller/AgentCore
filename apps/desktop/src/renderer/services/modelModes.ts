import { api } from "@/services/api";
import type { components } from "@/types/api.generated";

/**
 * 质量档 (model quality-mode) REST layer. A *mode* maps team roles to concrete
 * models; the user picks one per conversation (an override) or as their account
 * default. The backend exposes read-only built-in presets (`economy` / `quality`)
 * plus the user's own custom modes.
 *
 * The wire shapes are the OpenAPI-generated types (`pnpm gen:types`, single source
 * = `agentcore/api/schemas/model_modes.py`); only the camelCased {@link ModelModes}
 * view the UI reads from is defined here.
 */
type Schemas = components["schemas"];

/** A built-in, read-only 质量档 (server-shaped; its `key` is a stable ref). */
export type ModelModePreset = Schemas["ModelModePreset"];

/** A user-defined custom 质量档 (server-shaped; its `id` is the ref used in `model_mode`). */
export type ModelModeSummary = Schemas["ModelModeSummary"];

/** Everything the tier picker needs in one trip, camelCased for the app. */
export interface ModelModes {
  presets: ModelModePreset[];
  custom: ModelModeSummary[];
  /** The user's resolved account default ref (a preset key or a custom id) —
   * what「跟随默认」actually maps to. */
  defaultMode: string;
}

/** Human labels for the built-in presets; an unknown key falls back to itself. */
const PRESET_LABELS: Record<string, string> = {
  economy: "经济",
  quality: "高质",
};

/** Display name for a preset key (经济 / 高质), or the raw key if unrecognized. */
export function presetLabel(key: string): string {
  return PRESET_LABELS[key] ?? key;
}

/** Display name for a mode ref (preset key or custom id) against a loaded set;
 * falls back to「默认」when the ref can't be resolved (e.g. a since-deleted mode). */
export function modeLabel(
  ref: string | null,
  modes: ModelModes | null,
): string {
  if (!ref) return "默认";
  if (PRESET_LABELS[ref]) return PRESET_LABELS[ref];
  const custom = modes?.custom.find((m) => m.id === ref);
  if (custom) return custom.name;
  const preset = modes?.presets.find((p) => p.key === ref);
  return preset ? presetLabel(preset.key) : "默认";
}

/** Built-in presets + the user's custom modes + resolved default (`GET /v1/model-modes`). */
export async function listModelModes(): Promise<ModelModes> {
  const res = await api.get<Schemas["ModelModesResponse"]>("/v1/model-modes");
  return {
    presets: res.presets,
    custom: res.custom,
    defaultMode: res.default_mode,
  };
}

/** Set (or clear with `null`) the account-default 质量档 (`PUT /v1/model-modes/default`). */
export async function setDefaultModelMode(mode: string | null): Promise<void> {
  const body: Schemas["SetDefaultModeRequest"] = { mode };
  await api.put("/v1/model-modes/default", body);
}
