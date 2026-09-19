import { lazy } from "react";

/**
 * 冷冻回放块的懒加载表（写法对齐手册 embedRegistry）。
 * 正反热路径只挂这些 wrapper，勿静态 import 目标模块。
 */
export const ClosingBlocks = lazy(() =>
  import("./ClosingBlocks").then((m) => ({ default: m.ClosingBlocks })),
);

export const WitnessExamSection = lazy(() =>
  import("./WitnessExamSection").then((m) => ({
    default: m.WitnessExamSection,
  })),
);
