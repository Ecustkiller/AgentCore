import type { ComponentType } from "react";
import { CHAPTER_FRAMES } from "../core/chapter/types";
import { ChaptersMain, ChapterTitleScene, StillChapter } from "./Chapters";
import { ComposerSend } from "./ComposerSend";
import {
  COMPOSER_FRAMES,
  FPS,
  HEIGHT,
  LOGO_FRAMES,
  WIDTH,
} from "./constants";
import { GraphRun } from "./GraphRun";
import { GRAPH_SCENE_FRAMES } from "./hero/schedule";
import { LogoScene } from "./LogoScene";
import { LOOP_CHAPTERS } from "./loopChapters";
import { PixelCheck } from "./PixelCheck";

export interface CompositionDef {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  defaultProps?: Record<string, unknown>;
}

export interface StillDefReg {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  width: number;
  height: number;
  defaultProps?: Record<string, unknown>;
}

/** Reusable kit primitives. Films live in src/films/. */
export const kitManifest = {
  id: "kit",
  compositions: [
    {
      id: "Kit-ComposerSend",
      component: ComposerSend,
      durationInFrames: COMPOSER_FRAMES,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
    },
    {
      id: "Kit-GraphRun",
      component: GraphRun,
      durationInFrames: GRAPH_SCENE_FRAMES,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
    },
    {
      id: "Kit-Logo",
      component: LogoScene,
      durationInFrames: LOGO_FRAMES,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
    },
    {
      id: "Kit-Chapters",
      component: ChaptersMain,
      durationInFrames: CHAPTER_FRAMES * LOOP_CHAPTERS.length,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
    },
    {
      id: "Kit-Chapter",
      component: ChapterTitleScene,
      durationInFrames: CHAPTER_FRAMES,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      defaultProps: { chapterIndex: 0 },
    },
  ] as CompositionDef[],
  stills: [
    {
      id: "PixelCheck",
      component: PixelCheck,
      width: WIDTH,
      height: HEIGHT,
    },
    {
      id: "Kit-Still-Chapter",
      component: StillChapter,
      width: WIDTH,
      height: HEIGHT,
    },
  ] as StillDefReg[],
};
