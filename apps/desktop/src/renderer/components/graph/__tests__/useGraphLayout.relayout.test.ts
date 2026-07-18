// @vitest-environment jsdom
/**
 * 结构重算不得把 layoutReady 打回 false（否则 GraphView 卸载 ReactFlow → 整图闪烁）。
 */
import type { Execution } from "@/stores/execution";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const computeLayout = vi.fn();

vi.mock("@/lib/elk-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/elk-layout")>();
  return {
    ...actual,
    computeLayout: (...args: unknown[]) => computeLayout(...args),
  };
});

import { useGraphLayout } from "../useGraphLayout";

function exec(runIds: string[]): Execution {
  return {
    runs: [
      {
        id: "captain",
        kind: "captain",
        dependsOn: [],
        agentId: "ceo",
        task: "",
        status: "running",
        parentRunId: null,
        replacesRunId: null,
      },
      ...runIds.map((id) => ({
        id,
        kind: "agent" as const,
        dependsOn: [] as string[],
        agentId: id,
        task: id,
        status: "running" as const,
        parentRunId: null,
        replacesRunId: null,
      })),
    ],
  } as unknown as Execution;
}

describe("useGraphLayout · keep graph during relayout", () => {
  beforeEach(() => {
    computeLayout.mockReset();
    let n = 0;
    computeLayout.mockImplementation(async (nodeIds: string[]) => {
      n += 1;
      const positions: Record<string, { x: number; y: number }> = {};
      for (const id of nodeIds) {
        positions[id] = { x: n * 10, y: n * 20 };
      }
      return {
        positions,
        width: 400 + n,
        height: 300 + n,
        groups: [],
      };
    });
  });

  it("keeps layoutReady true across structural append (追加委派)", async () => {
    const emptyExpand = new Set<string>();
    const { result, rerender } = renderHook(
      ({ execution }: { execution: Execution }) =>
        useGraphLayout(execution, "tree", "view", emptyExpand),
      { initialProps: { execution: exec(["w1"]) } },
    );

    await waitFor(() => expect(result.current.layoutReady).toBe(true));
    const readySnapshots: boolean[] = [];

    await act(async () => {
      rerender({ execution: exec(["w1", "w2"]) });
      // 同步读：结构 effect 已跑但 ELK 未完成时不得 blank。
      readySnapshots.push(result.current.layoutReady);
    });

    expect(readySnapshots.every((v) => v)).toBe(true);
    await waitFor(() => {
      expect(result.current.layoutReady).toBe(true);
      expect(Object.keys(result.current.positions)).toEqual(
        expect.arrayContaining(["w1", "w2"]),
      );
    });
  });
});
