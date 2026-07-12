import { ViewportPortal } from "@xyflow/react";
import { Fragment } from "react";
import type { WaveBand } from "./helpers";

interface DebateStageBandsProps {
  bands: WaveBand[];
}

/**
 * 辩论阶段分区（协作图）：每一阶段（第 1 轮含主持人开场 / 第 N 轮 / 结辩）一块柔和高亮区，
 * 顶部骑一个轮次胶囊标签。纯装饰层（ViewportPortal，zIndex 垫底，pointer-events:none），
 * 不参与布局 / 交互。坐标为 flow 坐标（{@link WaveBand}）。
 */
export function DebateStageBands({ bands }: DebateStageBandsProps) {
  if (bands.length === 0) return null;
  return (
    <ViewportPortal>
      {bands.map((b) => (
        <Fragment key={b.id}>
          <div
            className="rounded-xl bg-primary/[0.06] ring-1 ring-inset ring-primary/15"
            style={{
              position: "absolute",
              transform: `translate(${b.x}px, ${b.y}px)`,
              width: b.w,
              height: b.h,
              zIndex: -1,
              pointerEvents: "none",
            }}
          />
          <div
            className="rounded-full border border-primary/30 bg-background px-2.5 py-0.5 text-xs font-medium text-primary shadow-sm"
            style={{
              position: "absolute",
              transform: `translate(${b.labelX}px, ${b.labelY}px) translate(-50%, -50%)`,
              zIndex: 1,
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            {b.label}
          </div>
        </Fragment>
      ))}
    </ViewportPortal>
  );
}
