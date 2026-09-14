import type { Execution } from "@/stores/execution";
import { describe, expect, it } from "vitest";
import { projectFlowEdges } from "../projectFlowGraph";

function execWithLossyDep(): Execution {
  return {
    runs: [
      { id: "up", status: "completed", kind: "agent", receivedContext: [] },
      {
        id: "down",
        status: "completed",
        kind: "agent",
        receivedContext: [
          {
            channel: "dependency",
            heading: "前置结果（来自 视觉）",
            body: "digest",
            chars: 80,
            truncated: true,
            source_role: "视觉与样式工程师",
            source_run_id: "up",
            fidelity: "pointer",
            files: ["index.html"],
          },
        ],
      },
    ],
  } as Execution;
}

const shared = {
  injectOverlay: null,
  execution: execWithLossyDep(),
  positions: { up: { x: 0, y: 0 }, down: { x: 200, y: 0 } },
  nodeSizes: {},
  handleDirection: "horizontal" as const,
  captainRun: null,
  captainStatus: null,
};

describe("projectFlowEdges · no fidelity chrome", () => {
  it("does not attach pointer / summarize / truncation onto dep edges", () => {
    const edges = projectFlowEdges({
      ...shared,
      edges: [{ id: "up=>down", source: "up", target: "down" }],
    });
    expect(edges).toHaveLength(1);
    const data = edges[0]?.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("handoff");
    expect(JSON.stringify(data)).not.toMatch(
      /指针|摘要|截断|pointer|summarize/,
    );
  });

  it("keeps 接替 as edge kind, not a fidelity payload", () => {
    const edges = projectFlowEdges({
      ...shared,
      edges: [
        { id: "up=>down", source: "up", target: "down", kind: "handoff" },
      ],
    });
    expect(edges[0]?.data).toMatchObject({ kind: "handoff" });
    expect(edges[0]?.data).not.toHaveProperty("handoff");
  });
});
