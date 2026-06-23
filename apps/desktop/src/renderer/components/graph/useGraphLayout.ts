/** ELK layout state and structure-gated recompute for GraphView. */

import { computeLayout } from "@/lib/elk-layout";
import type { Execution } from "@/stores/execution";
import type { GraphEdge, GraphLayout } from "@/stores/graph";
import type { NodeChange } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INPUT_ID } from "./constants";
import { buildGraphStructure } from "./helpers";

export function useGraphLayout(
  execution: Execution | null,
  layoutKind: GraphLayout,
) {
  const projectedRunsRef = useRef(execution?.runs);
  projectedRunsRef.current = execution?.runs;

  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [bbox, setBbox] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [layoutReady, setLayoutReady] = useState(false);
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});

  const setLayout = useCallback(
    (
      nextPositions: Record<string, { x: number; y: number }>,
      nextEdges: GraphEdge[],
    ) => {
      setPositions(nextPositions);
      setEdges(nextEdges);
    },
    [],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodeHeights((prev) => {
      let next = prev;
      for (const c of changes) {
        if (c.type === "dimensions" && c.dimensions) {
          const h = c.dimensions.height;
          if (h > 0 && prev[c.id] !== h) {
            if (next === prev) next = { ...prev };
            next[c.id] = h;
          }
        }
      }
      return next;
    });
  }, []);

  const structuralKey = useMemo(
    () =>
      execution
        ? execution.runs
            .map(
              (s) => `${s.id}:${s.dependsOn.join(",")}:${s.parentRunId ?? ""}`,
            )
            .join("|")
        : "",
    [execution],
  );

  useEffect(() => {
    if (!structuralKey) {
      setLayout({}, []);
      setBbox(null);
      setLayoutReady(false);
      return;
    }
    const runs = projectedRunsRef.current ?? [];
    const debate = runs.some((r) => r.stance != null);
    const captainId = runs.find((r) => r.kind === "captain")?.id ?? null;
    const { nodeIds, rawEdges } = buildGraphStructure(runs, INPUT_ID);

    let cancelled = false;
    computeLayout(nodeIds, rawEdges, layoutKind, debate, {
      source: INPUT_ID,
      sink: captainId ?? undefined,
    }).then((result) => {
      if (cancelled) return;
      setLayout(result.positions, rawEdges);
      setBbox({ width: result.width, height: result.height });
      setLayoutReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [structuralKey, layoutKind, setLayout]);

  return {
    positions,
    edges,
    bbox,
    layoutReady,
    nodeHeights,
    onNodesChange,
  };
}
