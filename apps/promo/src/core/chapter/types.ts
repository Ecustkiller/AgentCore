export interface ChapterDef {
  num: string;
  title: string;
  subtitle: string;
}

/** Per-card length in Studio / sequence (@30fps ≈ 2s). */
export const CHAPTER_FRAMES = 60;
