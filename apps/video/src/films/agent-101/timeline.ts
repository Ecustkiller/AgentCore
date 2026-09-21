import { CHAPTER_FRAMES } from "../../core/chapter/types";
import { LOGO_FRAMES } from "../../kit/constants";
import { LOOP_CHAPTERS } from "../../kit/loopChapters";

/** Structural beats only. 口播 / 分镜未定，不在这里发明镜头。 */
export const SHOTS = [
  { id: "logo", from: 0, frames: LOGO_FRAMES, note: "字标 + slogan" },
  ...LOOP_CHAPTERS.map((ch, i) => ({
    id: `chapter-${ch.num}`,
    from: LOGO_FRAMES + i * CHAPTER_FRAMES,
    frames: CHAPTER_FRAMES,
    note: `${ch.title} · ${ch.subtitle}`,
  })),
] as const;

export const FILM_DURATION =
  LOGO_FRAMES + LOOP_CHAPTERS.length * CHAPTER_FRAMES;
