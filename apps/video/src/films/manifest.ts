import type { ComponentType } from "react";
import { FPS, HEIGHT, WIDTH } from "../kit/constants";
import { Agent101Film } from "./agent-101/composition";
import { FILM_DURATION } from "./agent-101/timeline";

export interface FilmDef {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
}

/** One composition per film package. New film: add a folder, register here. */
export const filmsManifest = {
  compositions: [
    {
      id: "Film-Agent101",
      component: Agent101Film,
      durationInFrames: FILM_DURATION,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
    },
  ] as FilmDef[],
};
