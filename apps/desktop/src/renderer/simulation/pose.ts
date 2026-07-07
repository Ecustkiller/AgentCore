import type { Vec3 } from "@agentcore/contract-types";

export type SimAgentPose = Vec3 & {
  /** Y-axis rotation in radians. */
  yaw: number;
};
