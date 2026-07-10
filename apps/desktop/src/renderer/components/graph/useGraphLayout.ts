/** Layout one or more turn DAGs (ELK) for the conversation canvas. */

import {
  type GroupLayout,
  NODE_HEIGHT,
  NODE_WIDTH,
  type NodeSizeMap,
  computeLayout,
  nodeSpacingForFitMode,
} from "@/lib/elk-layout";
import type { ElkGraphLayout } from "@/lib/graph-layout-utils";
import type { Execution } from "@/stores/execution";
import type { GraphEdge, GraphLayout } from "@/stores/graph";
import type { NodeChange } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INPUT_ID } from "./constants";
import {
  type GraphFoldInfo,
  type SubTeam,
  buildGraphStructure,
  computeGraphFold,
} from "./helpers";
import type { GraphFitMode } from "./useGraphViewport";

export interface TurnLayoutSlice {
  positions: Record<string, { x: number; y: number }>;
  edges: GraphEdge[];
  bbox: { width: number; height: number } | null;
  layoutReady: boolean;
  nodeHeights: Record<string, number>;
  nodeSizes: Record<string, { width: number; height: number }>;
  groups: GroupLayout[];
  subTeams: SubTeam[];
  foldInfo: GraphFoldInfo | null;
}

const EMPTY_SLICE: TurnLayoutSlice = {
  positions: {},
  edges: [],
  bbox: null,
  layoutReady: false,
  nodeHeights: {},
  nodeSizes: {},
  groups: [],
  subTeams: [],
  foldInfo: null,
};

function buildNodeSizeMap(nodeIds: string[]): NodeSizeMap {
  const out: NodeSizeMap = {};
  for (const id of nodeIds) {
    out[id] = { width: NODE_WIDTH, height: NODE_HEIGHT };
  }
  // Bookends keep full size.
  out[INPUT_ID] = { width: NODE_WIDTH, height: NODE_HEIGHT };
  return out;
}

function expandedUnitsFromFold(
  runs: Execution["runs"],
  collapsedSubtrees: ReadonlySet<string>,
): Set<string> {
  const captainId = runs.find((r) => r.kind === "captain")?.id ?? null;
  const foldInfo = computeGraphFold(runs, captainId);
  const expanded = new Set<string>();
  for (const unit of foldInfo.descendants.keys()) {
    if (foldInfo.debateUnits.has(unit)) continue;
    if (!collapsedSubtrees.has(unit)) expanded.add(unit);
  }
  return expanded;
}

export function useGraphLayout(
  execution: Execution | null,
  layoutKind: GraphLayout,
  fitMode: GraphFitMode = "view",
  expandedUnits: ReadonlySet<string> = new Set(),
): TurnLayoutSlice & {
  onNodesChange: (changes: NodeChange[]) => void;
} {
  const projectedRunsRef = useRef(execution?.runs);
  projectedRunsRef.current = execution?.runs;

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
    return `${struct}::${expandKey}`;
  }, [execution, expandedUnits]);

  const subTeams = useMemo<SubTeam[]>(() => {
    if (!structuralKey || !execution) return [];
    return buildGraphStructure(execution.runs, INPUT_ID, expandedUnits)
      .subTeams;
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
      setGroups([]);
      setLayoutReady(false);
      return;
    }
    const runs = projectedRunsRef.current ?? [];
    const captainId = runs.find((r) => r.kind === "captain")?.id ?? null;
    const {
      nodeIds,
      rawEdges,
      subTeams: layoutSubTeams,
    } = buildGraphStructure(runs, INPUT_ID, expandedUnits);
    const sizeMap = buildNodeSizeMap(nodeIds);

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
      sizeMap,
    ).then((result) => {
      if (cancelled) return;
      setLayout(result.positions, rawEdges);
      setBbox({ width: result.width, height: result.height });
      setNodeSizes(sizeMap);
      setGroups(result.groups);
      setLayoutReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [structuralKey, layoutKind, fitMode, setLayout, expandedUnits]);

  return {
    positions,
    edges,
    bbox,
    layoutReady,
    nodeHeights,
    nodeSizes,
    onNodesChange,
    groups,
    subTeams,
    foldInfo,
  };
}

export interface MultiTurnLayoutInput {
  turnId: string;
  execution: Execution;
}

/**
 * Layout every expanded team turn. Hook count is fixed; turn set is keyed.
 */
export function useMultiTurnLayouts(
  turns: MultiTurnLayoutInput[],
  layoutKind: GraphLayout,
  collapsedSubtrees: ReadonlySet<string>,
  fitMode: GraphFitMode = "contain",
): {
  layouts: Record<string, TurnLayoutSlice>;
  onNodesChange: (turnId: string, changes: NodeChange[]) => void;
} {
  const [layouts, setLayouts] = useState<Record<string, TurnLayoutSlice>>({});
  const [heightByTurn, setHeightByTurn] = useState<
    Record<string, Record<string, number>>
  >({});
  const genRef = useRef(0);

  const turnKey = useMemo(
    () =>
      turns
        .map((t) => {
          const units = [
            ...expandedUnitsFromFold(t.execution.runs, collapsedSubtrees),
          ]
            .sort()
            .join(",");
          const struct = t.execution.runs
            .map(
              (r) =>
                `${r.id}:${r.dependsOn.join(",")}:${r.parentRunId ?? ""}`,
            )
            .join("|");
          return `${t.turnId}#${struct}#${units}`;
        })
        .join("||"),
    [turns, collapsedSubtrees],
  );

  useEffect(() => {
    const gen = ++genRef.current;
    if (turns.length === 0) {
      setLayouts({});
      return;
    }

    let cancelled = false;
    const next: Record<string, TurnLayoutSlice> = {};

    const run = async () => {
      for (const t of turns) {
        const expandedUnits = expandedUnitsFromFold(
          t.execution.runs,
          collapsedSubtrees,
        );
        const captainId =
          t.execution.runs.find((r) => r.kind === "captain")?.id ?? null;
        const {
          nodeIds,
          rawEdges,
          subTeams,
          foldInfo,
        } = buildGraphStructure(t.execution.runs, INPUT_ID, expandedUnits);
        const sizeMap = buildNodeSizeMap(nodeIds);

        const result = await computeLayout(
          nodeIds,
          rawEdges,
          layoutKind as ElkGraphLayout,
          { source: INPUT_ID, sink: captainId ?? undefined },
          subTeams,
          nodeSpacingForFitMode(fitMode),
          sizeMap,
        );
        if (cancelled || gen !== genRef.current) return;
        next[t.turnId] = {
          positions: result.positions,
          edges: rawEdges,
          bbox: { width: result.width, height: result.height },
          layoutReady: true,
          nodeHeights: heightByTurn[t.turnId] ?? {},
          nodeSizes: sizeMap,
          groups: result.groups,
          subTeams,
          foldInfo,
        };
      }
      if (cancelled || gen !== genRef.current) return;
      setLayouts(next);
    };

    // Mark not-ready stubs so spine doesn't flash wrong LOD.
    const stubs: Record<string, TurnLayoutSlice> = {};
    for (const t of turns) {
      stubs[t.turnId] = {
        ...EMPTY_SLICE,
        foldInfo: computeGraphFold(
          t.execution.runs,
          t.execution.runs.find((r) => r.kind === "captain")?.id ?? null,
        ),
        layoutReady: false,
      };
    }
    setLayouts((prev) => {
      const merged = { ...stubs };
      for (const id of Object.keys(stubs)) {
        if (prev[id]?.layoutReady) merged[id] = prev[id];
      }
      return merged;
    });

    void run();
    return () => {
      cancelled = true;
    };
    // heightByTurn intentionally omitted — dimension patches don't re-ELK.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnKey, layoutKind, fitMode]);

  const onNodesChange = useCallback(
    (turnId: string, changes: NodeChange[]) => {
      setHeightByTurn((prev) => {
        const cur = prev[turnId] ?? {};
        let next = cur;
        for (const c of changes) {
          if (c.type === "dimensions" && c.dimensions) {
            const h = c.dimensions.height;
            if (h > 0 && cur[c.id] !== h) {
              if (next === cur) next = { ...cur };
              next[c.id] = h;
            }
          }
        }
        if (next === cur) return prev;
        return { ...prev, [turnId]: next };
      });
      setLayouts((prev) => {
        const slice = prev[turnId];
        if (!slice) return prev;
        const cur = slice.nodeHeights;
        let next = cur;
        for (const c of changes) {
          if (c.type === "dimensions" && c.dimensions) {
            const h = c.dimensions.height;
            if (h > 0 && cur[c.id] !== h) {
              if (next === cur) next = { ...cur };
              next[c.id] = h;
            }
          }
        }
        if (next === cur) return prev;
        return {
          ...prev,
          [turnId]: { ...slice, nodeHeights: next },
        };
      });
    },
    [],
  );

  return { layouts, onNodesChange };
}

export { expandedUnitsFromFold, buildNodeSizeMap };
