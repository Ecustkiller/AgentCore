import raw from "./manual-scenes.json";

export interface ManualPreviewScene {
  id: string;
  description: string;
  path: string;
  /** Scroll target section id (`?s=`). Omit for page top. */
  section?: string;
}

/** Static manual pages for offline screenshot harness (`pnpm shoot:manual`). */
export const MANUAL_PREVIEW_SCENES = raw as ManualPreviewScene[];
