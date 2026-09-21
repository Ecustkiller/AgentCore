import { AbsoluteFill, useCurrentFrame } from "remotion";
import {
  ChapterTitleCard,
  ChapterTitleVisual,
} from "../core/chapter/ChapterTitleCard";
import { CHAPTER_FRAMES } from "../core/chapter/types";
import { LOOP_CHAPTERS } from "./loopChapters";

export function ChaptersMain() {
  const frame = useCurrentFrame();
  const idx = Math.min(
    LOOP_CHAPTERS.length - 1,
    Math.floor(frame / CHAPTER_FRAMES),
  );
  const local = frame - idx * CHAPTER_FRAMES;
  return (
    <AbsoluteFill className="dark bg-background">
      <ChapterTitleVisual frame={local} chapter={LOOP_CHAPTERS[idx]} />
    </AbsoluteFill>
  );
}

export function ChapterTitleScene({
  chapterIndex = 0,
}: {
  chapterIndex?: number;
}) {
  const chapter =
    LOOP_CHAPTERS[
      Math.max(0, Math.min(LOOP_CHAPTERS.length - 1, chapterIndex))
    ];
  return (
    <AbsoluteFill className="dark bg-background">
      <ChapterTitleCard chapter={chapter} />
    </AbsoluteFill>
  );
}

export function StillChapter() {
  return (
    <AbsoluteFill className="dark bg-background">
      <ChapterTitleVisual frame={30} chapter={LOOP_CHAPTERS[0]} />
    </AbsoluteFill>
  );
}
