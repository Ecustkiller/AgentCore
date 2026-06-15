import {
  type ModelModePreset,
  type ModelModeSummary,
  listModelModes,
} from "@/services/modelModes";
import { create } from "zustand";

/**
 * 质量档 catalog cache (D2) — the presets + the user's custom modes + their
 * resolved default, shared by the composer selector and the settings page so the
 * picker doesn't refetch on every render. CRUD on the settings page calls
 * {@link refresh} so the composer's option list and "跟随默认" label stay current.
 *
 * `draftMode` holds the selection for a chat that has no id yet (the composer is
 * always visible, including on a fresh draft); the send path passes it at
 * conversation creation, then resets it. null = inherit the user/operator default.
 */
interface ModelModesState {
  presets: ModelModePreset[];
  custom: ModelModeSummary[];
  /** The user's resolved default ref (user default → operator default; never null). */
  defaultMode: string;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Pending selection for a not-yet-created conversation (null = inherit). */
  draftMode: string | null;
  /** Fetch once (no-op if already loaded or in flight). */
  ensureLoaded: () => Promise<void>;
  /** Force a refetch (after CRUD / default change). */
  refresh: () => Promise<void>;
  setDraftMode: (mode: string | null) => void;
}

export const useModelModesStore = create<ModelModesState>((set, get) => {
  const load = async (): Promise<void> => {
    set({ loading: true, error: null });
    try {
      const res = await listModelModes();
      set({
        presets: res.presets,
        custom: res.custom,
        defaultMode: res.default_mode,
        loaded: true,
        loading: false,
      });
    } catch {
      set({ loading: false, error: "加载质量档失败" });
    }
  };

  return {
    presets: [],
    custom: [],
    defaultMode: "economy",
    loaded: false,
    loading: false,
    error: null,
    draftMode: null,
    ensureLoaded: async () => {
      if (get().loaded || get().loading) return;
      await load();
    },
    refresh: load,
    setDraftMode: (mode) => set({ draftMode: mode }),
  };
});
