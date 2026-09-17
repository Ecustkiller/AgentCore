import { lazy } from "react";

/**
 * 旧场回放块的懒加载表（写法对齐手册 embedRegistry）。
 * 正反热路径只挂这些 wrapper，勿静态 import 目标模块。
 */
export const ClosingBlocks = lazy(() =>
  import("./ClosingBlocks").then((m) => ({ default: m.ClosingBlocks })),
);

export const FindingThreads = lazy(() =>
  import("./FindingThreads").then((m) => ({ default: m.FindingThreads })),
);

export const ThreadTurns = lazy(() =>
  import("./ThreadTurns").then((m) => ({ default: m.ThreadTurns })),
);

export const WitnessExamSection = lazy(() =>
  import("./WitnessExamSection").then((m) => ({
    default: m.WitnessExamSection,
  })),
);

export const ReplayBriefCard = lazy(() =>
  import("./brief/replay").then((m) => ({ default: m.ReplayBriefCard })),
);
