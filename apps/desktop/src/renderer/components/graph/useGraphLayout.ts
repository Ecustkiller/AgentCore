/** ELK / time-axis layout state and structure-gated recompute for GraphView. */

import {
  type GroupLayout,
  computeLayout,
  nodeSpacingForFitMode,
} from "@/lib/elk-layout";
import {
  type ElkGraphLayout,
  isTimelineLayout,
} from "@/lib/graph-layout-utils";
import { computeTimeLayout } from "@/lib/time-layout";
import type { Execution } from "@/stores/execution";
import type { GraphEdge, GraphLayout } from "@/stores/graph";
import type { NodeChange } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INPUT_ID } from "./constants";
import { type SubTeam, buildGraphStructure } from "./helpers";
import type { GraphFitMode } from "./useGraphViewport";

export function useGraphLayout(
  execution: Execution | null,
  layoutKind: GraphLayout,
  fitMode: GraphFitMode = "view",
  expandedUnits: ReadonlySet<string> = new Set(),
) {
  const projectedRunsRef = useRef(execution?.runs);
  projectedRunsRef.current = execution?.runs;
  const projectedBatchesRef = useRef(execution?.batches);
  projectedBatchesRef.current = execution?.batches;

  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [bbox, setBbox] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [nodeSizes, setNodeSizes] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [batchDividers, setBatchDividers] = useState<
    { x: number; label: string }[]
  >([]);
  const [layoutReady, setLayoutReady] = useState(false);
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});
  const [groups, setGroups] = useState<GroupLayout[]>([]);

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

  const structuralKey = useMemo(() => {
    if (!execution) return "";
    const struct = execution.runs
      .map((s) => `${s.id}:${s.dependsOn.join(",")}:${s.parentRunId ?? ""}`)
      .join("|");
    const expandKey = [...expandedUnits].sort().join(",");
    if (!isTimelineLayout(layoutKind)) return `${struct}::${expandKey}`;
    const batchKey = execution.batches
      .map((b) =>
        b.timeline.map((t) => `${t.runId}:${t.startMs}-${t.endMs}`).join(","),
      )
      .join("|");
    return `${struct}::${batchKey}::${expandKey}`;
  }, [execution, layoutKind, expandedUnits]);

  const subTeams = useMemo<SubTeam[]>(() => {
    if (!structuralKey || !execution) return [];
    return buildGraphStructure(execution.runs, INPUT_ID, expandedUnits).subTeams;
  }, [structuralKey, execution, expandedUnits]);

  const foldInfo = useMemo(() => {
    if (!execution) return null;
    return buildGraphStructure(execution.runs, INPUT_ID, expandedUnits)
      .foldInfo;
  }, [execution, expandedUnits]);

  useEffect(() => {
    if (!structuralKey) {
      setLayout({}, []);
      setBbox(null);
      setNodeSizes({});
      setBatchDividers([]);
      setGroups([]);
      setLayoutReady(false);
      return;
    }
    const runs = projectedRunsRef.current ?? [];
    const batches = projectedBatchesRef.current ?? [];
    const captainId = runs.find((r) => r.kind === "captain")?.id ?? null;
    const {
      nodeIds,
      rawEdges,
      subTeams: layoutSubTeams,
    } = buildGraphStructure(runs, INPUT_ID, expandedUnits);

    if (isTimelineLayout(layoutKind)) {
      if (!execution) return;
      const result = computeTimeLayout(
        {
          ...execution,
          runs,
          batches,
        },
        nodeIds,
        INPUT_ID,
        captainId,
      );
      setLayout(result.positions, rawEdges);
      setBbox({ width: result.width, height: result.height });
      setNodeSizes(result.sizes);
      setBatchDividers(result.batchDividers);
      setGroups([]);
      setLayoutReady(true);
      return;
    }

    let cancelled = false;
    const elkLayout = layoutKind as ElkGraphLayout;
    const nodeSpacing = nodeSpacingForFitMode(fitMode);
    computeLayout(
      nodeIds,
      rawEdges,
      elkLayout,
      {
        source: INPUT_ID,
        sink: captainId ?? undefined,
      },
      layoutSubTeams,
      nodeSpacing,
    ).then((result) => {
      if (cancelled) return;
      setLayout(result.positions, rawEdges);
      setBbox({ width: result.width, height: result.height });
      setNodeSizes({});
      setBatchDividers([]);
      setGroups(result.groups);
      setLayoutReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [structuralKey, layoutKind, fitMode, setLayout, execution, expandedUnits]);

  return {
    positions,
    edges,
    bbox,
    layoutReady,
    nodeHeights,
    nodeSizes,
    batchDividers,
    onNodesChange,
    groups,
    subTeams,
    foldInfo,
  };
}
