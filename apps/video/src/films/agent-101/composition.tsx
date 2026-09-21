import { AbsoluteFill, Sequence } from "remotion";
import { ChapterTitleCard } from "../../core/chapter/ChapterTitleCard";
import { CHAPTER_FRAMES } from "../../core/chapter/types";
import { Subtitles } from "../../core/Subtitles";
import { LOGO_FRAMES } from "../../kit/constants";
import { LogoScene } from "../../kit/LogoScene";
import { LOOP_CHAPTERS } from "../../kit/loopChapters";
import { CUES } from "./copy";

/**
 * Agent 科普片骨架：Logo + 主循环五拍章节卡。
 * 口播、协作图镜次未定，不在这里预演成片。
 */
export function Agent101Film() {
  return (
    <AbsoluteFill className="bg-background">
      <Sequence from={0} durationInFrames={LOGO_FRAMES}>
        <LogoScene />
      </Sequence>
      {LOOP_CHAPTERS.map((chapter, i) => (
        <Sequence
          key={chapter.num}
          from={LOGO_FRAMES + i * CHAPTER_FRAMES}
          durationInFrames={CHAPTER_FRAMES}
        >
          <AbsoluteFill className="dark bg-background">
            <ChapterTitleCard chapter={chapter} />
          </AbsoluteFill>
        </Sequence>
      ))}
      {CUES.length > 0 ? <Subtitles cues={CUES} /> : null}
    </AbsoluteFill>
  );
}

