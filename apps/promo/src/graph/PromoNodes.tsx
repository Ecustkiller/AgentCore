import { AgentNode } from "@/components/graph/AgentNode";
import { EndpointNode } from "@/components/graph/EndpointNode";
import type { NodeProps } from "@xyflow/react";
import { useCurrentFrame } from "remotion";
import { entranceStyle, flashShadow, pulseOpacity } from "../motion/primitives";

/*
 * Frame-driven wrappers around the REAL AgentNode / EndpointNode. The inner
 * component renders pixel-identically; the wrapper div re-applies the motions
 * styles.css neutralized — staggered entrance, running pulse, terminal flash —
 * from useCurrentFrame. Motion schedule rides on the node data under `_*` keys
 * (the inner components ignore unknown data keys).
 */

interface MotionFields {
  _enterFrame?: number;
  _terminalFrame?: number | null;
  _ok?: boolean;
  status?: string;
}

function useMotionStyle(data: MotionFields): React.CSSProperties {
  const frame = useCurrentFrame();
  const entrance = entranceStyle(frame, data._enterFrame ?? 0);
  const pulse = pulseOpacity(frame, data.status === "running");
  const shadow = flashShadow(frame, data._terminalFrame ?? null, data._ok ?? true);
  return {
    opacity: entrance.opacity * pulse,
    transform: entrance.transform,
    boxShadow: shadow,
    borderRadius: 12,
    willChange: "opacity, transform",
  };
}

export function PromoAgentNode(props: NodeProps) {
  const style = useMotionStyle(props.data as MotionFields);
  return (
    <div style={style}>
      <AgentNode {...props} />
    </div>
  );
}

export function PromoEndpointNode(props: NodeProps) {
  const style = useMotionStyle(props.data as MotionFields);
  return (
    <div style={style}>
      <EndpointNode {...props} />
    </div>
  );
}
