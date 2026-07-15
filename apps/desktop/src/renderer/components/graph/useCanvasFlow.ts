/**
 * Unified conversation-canvas flow: turn spine + up to N expanded turns' DAGs as
 * compound children in a single ReactFlow instance (no nested RF).
 */

import {
  hasParallelTimeline,
  parallelTimelineMetricsSummary,
} from "@/components/chat/ParallelTimeline";
import { captainSynthesisPreviewText } from "@/components/chat/teamSynthesisPhase";
import { useTurnAudit } from "@/hooks/useTurnAudit";
import { buildInjectGraphOverlay } from "@/lib/causalInject";
import { resolveEffectiveGraphLayout } from "@/lib/graph-layout-utils";
import { useConversationStore } from "@/stores/conversation";
import {
  type Execution,
  type RunStatus,
  useExecutionStore,
  useMessageExecution,
} from "@/stores/execution";
import { useConversationFold, useGraphStore } from "@/stores/graph";
import { type EndpointKind, useSidePanelStore } from "@/stores/sidePanel";
import { turnDetailPath } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import type { Edge, Node, NodeChange } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SimpleTurnData } from "./SimpleTurnNode";
import type { TurnGroupData } from "./TurnGroupNode";
import {
  TURN_GROUP_HEADER_H,
  TURN_GROUP_NOTES_FOOTER_H,
  TURN_GROUP_PAD,
} from "./TurnGroupNode";
import type { TurnSummaryData } from "./TurnSummaryNode";
import { computeKeepBrightIds, hoverRelatedIds } from "./graphHover";
import {
  type WaveBand,
  computeDebateStageBands,
  computeGraphFold,
  computeWaves,
  deriveCaptainStatus,
} from "./helpers";
import { planCapabilities } from "./planCapabilities";
import { projectFlowEdges, projectFlowNodes } from "./projectFlowGraph";
import {
  GAP_Y,
  SIMPLE_NODE_HEIGHT,
  TEAM_NODE_HEIGHT,
  TURN_NODE_WIDTH,
  type TurnItem,
} from "./useCanvasTurns";
import { useGraphDrillIn } from "./useGraphDrillIn";
import {
  type TurnLayoutSlice,
  expandedUnitsFromFold,
  useMultiTurnLayouts,
} from "./useGraphLayout";

const TURN_GROUP_FALLBACK_W = 760;
const TURN_GROUP_FALLBACK_H = 470;

function dedupeRoles(exec: NonNullable<TurnItem["exec"]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of exec.agents) {
    const r = a.role?.trim();
    if (!r || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

function layoutStructureSig(
  positions: Record<string, { x: number; y: number }>,
  nodeHeights: Record<string, number>,
  nodeSizes: Record<string, { width: number; height: number }>,
): string {
  const pos = Object.entries(positions)
    .map(([k, v]) => `${k}:${v.x},${v.y}`)
    .join("|");
  const heights = Object.entries(nodeHeights)
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
  const sizes = Object.entries(nodeSizes)
    .map(([k, v]) => `${k}:${v.width}x${v.height}`)
    .join("|");
  return `${pos}#${heights}#${sizes}`;
}

/** Nest a turn-DAG node under the turn compound (header + pad). */
function nestUnderTurn(node: Node, turnId: string): Node {
  if (node.parentId) {
    return {
      ...node,
      id: `${turnId}::${node.id}`,
      parentId: `${turnId}::${node.parentId}`,
      extent: "parent",
    };
  }
  return {
    ...node,
    id: `${turnId}::${node.id}`,
    parentId: turnId,
    extent: "parent",
    position: {
      x: node.position.x + TURN_GROUP_PAD,
      y: node.position.y + TURN_GROUP_HEADER_H + TURN_GROUP_PAD,
    },
  };
}

function nestEndpoint(id: string, turnId: string): string {
  return `${turnId}::${id}`;
}

export interface UseCanvasFlowOptions {
  turns: TurnItem[];
  effectiveFocus: string | null;
}

export function useCanvasFlow({ turns, effectiveFocus }: UseCanvasFlowOptions) {
  const navigate = useNavigate();
  const focusedExec = useMessageExecution(effectiveFocus);
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const caps = planCapabilities(focusedExec?.planType);
  const { data: turnAudit } = useTurnAudit(
    caps.auditInject ? conversationId : null,
    caps.auditInject ? effectiveFocus : null,
  );

  const layoutKind = useGraphStore((s) => s.layoutKind);
  const setLayoutKind = useGraphStore((s) => s.setLayoutKind);
  const showAuditInjectFlow = useGraphStore((s) => s.showAuditInjectFlow);
  const setShowAuditInjectFlow = useGraphStore((s) => s.setShowAuditInjectFlow);
  const fold = useConversationFold(conversationId);
  const expandTurn = useGraphStore((s) => s.expandTurn);
  const collapseTurn = useGraphStore((s) => s.collapseTurn);
  const ensureDefaultExpandedTurns = useGraphStore(
    (s) => s.ensureDefaultExpandedTurns,
  );
  const ensureSubtreeDefaults = useGraphStore((s) => s.ensureSubtreeDefaults);
  const toggleSubtreeCollapsed = useGraphStore((s) => s.toggleSubtreeCollapsed);

  const parallelAvailable = !!focusedExec && hasParallelTimeline(focusedExec);
  const effectiveLayoutKind = resolveEffectiveGraphLayout(layoutKind);

  // Seed default expanded turns (newest first, cap 3) once per conversation.
  useEffect(() => {
    if (!conversationId) return;
    const teamIdsNewestFirst = [...turns]
      .reverse()
      .filter((t) => t.kind === "team")
      .map((t) => t.id);
    if (teamIdsNewestFirst.length === 0) return;
    ensureDefaultExpandedTurns(conversationId, teamIdsNewestFirst);
  }, [conversationId, turns, ensureDefaultExpandedTurns]);

  // When a brand-new latest team turn appears, expand it (LRU). Does not
  // re-expand a turn the user just collapsed.
  const lastAutoExpandedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!conversationId) return;
    let latest: string | null = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].kind === "team") {
        latest = turns[i].id;
        break;
      }
    }
    if (!latest || lastAutoExpandedRef.current === latest) return;
    lastAutoExpandedRef.current = latest;
    expandTurn(conversationId, latest);
  }, [conversationId, turns, expandTurn]);

  const expandedTurnSet = useMemo(
    () => new Set(fold.expandedTurns),
    [fold.expandedTurns],
  );

  const collapsedSubtrees = useMemo(
    () => new Set(fold.collapsedSubtrees),
    [fold.collapsedSubtrees],
  );

  const expandedTurnInputs = useMemo(() => {
    const out: { turnId: string; execution: Execution }[] = [];
    for (const id of fold.expandedTurns) {
      const t = turns.find((x) => x.id === id);
      if (t?.kind === "team" && t.exec) {
        out.push({ turnId: id, execution: t.exec });
      }
    }
    return out;
  }, [fold.expandedTurns, turns]);

  // Seed newly discovered foldable parents as collapsed by default.
  useEffect(() => {
    if (!conversationId) return;
    for (const { execution } of expandedTurnInputs) {
      const captainId =
        execution.runs.find((r) => r.kind === "captain")?.id ?? null;
      const info = computeGraphFold(execution.runs, captainId);
      const parents = [...info.descendants.keys()].filter(
        (id) => !info.debateUnits.has(id),
      );
      if (parents.length > 0) ensureSubtreeDefaults(conversationId, parents);
    }
  }, [conversationId, expandedTurnInputs, ensureSubtreeDefaults]);

  const { layouts: turnLayouts, onNodesChange: onTurnNodesChange } =
    useMultiTurnLayouts(
      expandedTurnInputs,
      effectiveLayoutKind,
      collapsedSubtrees,
      "contain",
    );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const byTurn = new Map<string, NodeChange[]>();
      for (const c of changes) {
        if (!("id" in c) || typeof c.id !== "string") continue;
        const sep = c.id.indexOf("::");
        if (sep < 0) continue;
        const turnId = c.id.slice(0, sep);
        const bare = c.id.slice(sep + 2);
        const list = byTurn.get(turnId) ?? [];
        list.push({ ...c, id: bare });
        byTurn.set(turnId, list);
      }
      for (const [turnId, list] of byTurn) {
        onTurnNodesChange(turnId, list);
      }
    },
    [onTurnNodesChange],
  );

  const onToggleUnitExpand = useCallback(
    (unitId: string) => {
      if (!conversationId) return;
      toggleSubtreeCollapsed(conversationId, unitId);
    },
    [conversationId, toggleSubtreeCollapsed],
  );

  const onCollapseTurn = useCallback(
    (turnId: string) => {
      if (!conversationId) return;
      collapseTurn(conversationId, turnId);
    },
    [conversationId, collapseTurn],
  );

  const onExpandTurn = useCallback(
    (turnId: string) => {
      if (!conversationId) return;
      expandTurn(conversationId, turnId);
    },
    [conversationId, expandTurn],
  );

  const showRunDetail = useSidePanelStore((s) => s.showRunDetail);
  const showContentDetail = useSidePanelStore((s) => s.showContentDetail);

  const onNodeSelect = useCallback(
    (runId: string) => {
      if (!effectiveFocus || !focusedExec) return;
      const run = focusedExec.runs.find((r) => r.id === runId);
      const role = focusedExec.agents.find((a) => a.id === run?.agentId)?.role;
      showRunDetail(effectiveFocus, runId, role);
    },
    [effectiveFocus, focusedExec, showRunDetail],
  );

  const onEndpointSelect = useCallback(
    (contentMessageId: string, title: string, endpoint: EndpointKind) => {
      if (!effectiveFocus) return;
      showContentDetail(effectiveFocus, contentMessageId, title, endpoint);
    },
    [effectiveFocus, showContentDetail],
  );

  const {
    activateNode,
    showRunDetailHere,
    litRunId,
    litEndpointMessageId,
    finalAnswer,
    taskMessage,
    captainRun,
  } = useGraphDrillIn(focusedExec, {
    interactive: true,
    messageId: effectiveFocus,
    onNodeSelect,
    onEndpointSelect,
  });

  const cnyPerUsd = useUsageStore((s) => s.cnyPerUsd);
  const handleDirection =
    effectiveLayoutKind === "leftright"
      ? ("horizontal" as const)
      : ("vertical" as const);
  const edgePathType =
    effectiveLayoutKind === "tree"
      ? ("bezier" as const)
      : ("smoothstep" as const);

  const _captainStatus = useMemo<RunStatus | null>(
    () =>
      focusedExec && captainRun
        ? deriveCaptainStatus(focusedExec, captainRun.id)
        : null,
    [focusedExec, captainRun],
  );

  const focusedLayout: TurnLayoutSlice | null =
    effectiveFocus && turnLayouts[effectiveFocus]
      ? turnLayouts[effectiveFocus]
      : null;

  const injectOverlay = useMemo(
    () =>
      caps.auditInject && focusedLayout
        ? buildInjectGraphOverlay(
            turnAudit?.causal_graph,
            focusedLayout.edges,
            {
              focusRunId: litRunId,
              showAllInject: showAuditInjectFlow,
            },
          )
        : null,
    [
      caps.auditInject,
      turnAudit?.causal_graph,
      focusedLayout,
      litRunId,
      showAuditInjectFlow,
    ],
  );

  const injectFlowAvailable = useMemo(
    () =>
      caps.auditInject &&
      (turnAudit?.causal_graph?.edges?.some((e) => e.kind === "inject") ??
        false),
    [caps.auditInject, turnAudit?.causal_graph],
  );

  const metricsSummary = useMemo(
    () =>
      parallelAvailable && focusedExec
        ? parallelTimelineMetricsSummary(focusedExec)
        : null,
    [parallelAvailable, focusedExec],
  );

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [menuNodeId, setMenuNodeId] = useState<string | null>(null);
  const [keyboardFocusId, setKeyboardFocusId] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset hover/menu when focus target changes
  useEffect(() => {
    setHoveredNodeId(null);
    setMenuNodeId(null);
    setKeyboardFocusId(null);
  }, [effectiveFocus]);

  const maximizeTurn = useCallback(
    (turnId: string) => {
      if (!conversationId) return;
      navigate(turnDetailPath(conversationId, turnId));
    },
    [conversationId, navigate],
  );

  const execById = useExecutionStore((s) => s.byId);

  // Project DAG nodes/edges per expanded turn.
  const projectedByTurn = useMemo(() => {
    const out = new Map<
      string,
      {
        layoutNodes: Node[];
        presentData: Map<string, Node["data"]>;
        edges: Edge[];
      }
    >();
    for (const { turnId, execution } of expandedTurnInputs) {
      const slice = turnLayouts[turnId];
      if (!slice?.layoutReady || !slice.bbox) continue;
      const expandedUnits = expandedUnitsFromFold(
        execution.runs,
        collapsedSubtrees,
      );
      const captain = execution.runs.find((r) => r.kind === "captain") ?? null;
      const capStatus = captain
        ? deriveCaptainStatus(execution, captain.id)
        : null;
      const isFocus = turnId === effectiveFocus;
      const focusAnswer = isFocus ? finalAnswer : null;
      const synthPreview =
        !focusAnswer && capStatus === "running"
          ? captainSynthesisPreviewText(
              execById[turnId]?.teamSynthesisPreview ?? null,
            )
          : "";
      const base = {
        execution,
        positions: slice.positions,
        nodeHeights: slice.nodeHeights,
        nodeSizes: slice.nodeSizes,
        handleDirection,
        cnyPerUsd,
        litRunId: isFocus ? litRunId : null,
        litEndpointMessageId: isFocus ? litEndpointMessageId : null,
        captainRun: captain,
        captainStatus: capStatus,
        finalAnswer: focusAnswer,
        captainSynthesisPreview: synthPreview,
        taskMessage: isFocus ? taskMessage : null,
        activateNode: isFocus ? activateNode : () => undefined,
        groups: slice.groups,
        subTeams: slice.subTeams,
        foldInfo: slice.foldInfo ?? undefined,
        expandedUnits,
        onToggleUnitExpand,
        edgePathType,
      };
      const fresh = projectFlowNodes(base);
      const present = new Map(fresh.map((n) => [n.id, n.data]));
      const edges = projectFlowEdges({
        ...base,
        edges: slice.edges,
        injectOverlay: isFocus ? injectOverlay : null,
      });
      out.set(turnId, { layoutNodes: fresh, presentData: present, edges });
    }
    return out;
  }, [
    expandedTurnInputs,
    turnLayouts,
    collapsedSubtrees,
    handleDirection,
    cnyPerUsd,
    effectiveFocus,
    litRunId,
    litEndpointMessageId,
    finalAnswer,
    taskMessage,
    activateNode,
    onToggleUnitExpand,
    edgePathType,
    injectOverlay,
    execById,
  ]);

  // Morphing: brief CSS transition when layout structure changes.
  const [morphing, setMorphing] = useState(false);
  const morphTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLayoutSigRef = useRef<string>("");
  const layoutSig = useMemo(() => {
    return expandedTurnInputs
      .map(({ turnId }) => {
        const s = turnLayouts[turnId];
        if (s?.layoutError) return `${turnId}:error:${s.layoutError}`;
        if (!s?.layoutReady) return `${turnId}:pending`;
        return `${turnId}:${layoutStructureSig(s.positions, s.nodeHeights, s.nodeSizes)}`;
      })
      .join("||");
  }, [expandedTurnInputs, turnLayouts]);

  useEffect(() => {
    if (!layoutSig || layoutSig === prevLayoutSigRef.current) return;
    const hadPrev = prevLayoutSigRef.current.length > 0;
    prevLayoutSigRef.current = layoutSig;
    if (!hadPrev) return;
    setMorphing(true);
    if (morphTimerRef.current) clearTimeout(morphTimerRef.current);
    morphTimerRef.current = setTimeout(() => setMorphing(false), 320);
    return () => {
      if (morphTimerRef.current) clearTimeout(morphTimerRef.current);
    };
  }, [layoutSig]);

  const seenTurnsRef = useRef<Set<string>>(new Set());
  const firstSpineRef = useRef(true);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const turnSpineKey = useMemo(
    () =>
      turns
        .map((t) => {
          const notes = t.exec?.teamNotes?.length ?? 0;
          const status = t.exec?.status ?? "";
          return `${t.id}:${t.kind}:${t.pendingDecisions}:${t.recoverable ? 1 : 0}:${notes}:${status}`;
        })
        .join("|"),
    [turns],
  );

  const expandedKey = fold.expandedTurns.join(",");
  const projectedReadyKey = [...projectedByTurn.keys()].sort().join(",");

  // *Key strings force recompute when ref-backed turn data changes under stable deps.
  const {
    layoutNodes,
    layoutEdges,
    focusedGroupOrigin,
    focusedWaves,
    focusedDebateBands,
  } =
    // biome-ignore lint/correctness/useExhaustiveDependencies: turnSpineKey/expandedKey/projectedReadyKey are intentional invalidation keys
    useMemo(() => {
      const turnsNow = turnsRef.current;
      const outNodes: Node[] = [];
      const outEdges: Edge[] = [];
      let y = 0;
      const lastTurnId = turnsNow[turnsNow.length - 1]?.id;
      let groupOrigin: {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null = null;
      let waves: WaveBand[] = [];
      let debateBands: WaveBand[] = [];

      for (const t of turnsNow) {
        const expanded = t.kind === "team" && expandedTurnSet.has(t.id);
        const projected = projectedByTurn.get(t.id);
        const slice = turnLayouts[t.id];

        if (expanded && projected && slice?.layoutReady && slice.bbox) {
          const notes = t.exec?.teamNotes;
          const notesFooter =
            (notes?.length ?? 0) > 0 ? TURN_GROUP_NOTES_FOOTER_H : 0;
          const width = Math.max(
            TURN_GROUP_FALLBACK_W,
            slice.bbox.width + TURN_GROUP_PAD * 2,
          );
          // Height follows placed-content bbox only (host contract). Do not floor
          // to FALLBACK_H after layout — that recreated the “content at top /
          // empty band below” sink sibling of the old ELK dead zone.
          const height =
            TURN_GROUP_HEADER_H +
            slice.bbox.height +
            TURN_GROUP_PAD * 2 +
            notesFooter;
          const groupX = -(width / 2);
          const groupData: TurnGroupData = {
            messageId: t.id,
            taskSummary: t.exec?.taskSummary || t.prompt || "团队回合",
            pendingDecisions: t.pendingDecisions,
            recoverable: t.recoverable,
            onMaximize: () => maximizeTurn(t.id),
            onCollapse: () => onCollapseTurn(t.id),
            teamNotes: notes,
            status: t.exec?.status,
          };
          outNodes.push({
            id: t.id,
            type: "turnGroup",
            position: { x: groupX, y },
            style: { width, height },
            data: groupData,
            draggable: false,
            zIndex: 0,
            className: morphing ? "graph-layout-morphing" : undefined,
          });
          if (t.id === effectiveFocus) {
            groupOrigin = { x: groupX, y, width, height };
            if (t.exec) {
              const cap = t.exec.runs.find((r) => r.kind === "captain");
              waves = computeWaves(
                t.exec,
                slice.positions,
                slice.bbox,
                effectiveLayoutKind,
                cap?.id ?? null,
              );
              debateBands = computeDebateStageBands(
                t.exec,
                slice.positions,
                cap?.id ?? null,
              );
            }
          }

          for (const n of projected.layoutNodes) {
            const nested = nestUnderTurn(n, t.id);
            const classes = [
              nested.className,
              morphing ? "graph-layout-morphing" : "",
              keyboardFocusId === nested.id ? "graph-keyboard-focus" : "",
            ]
              .filter(Boolean)
              .join(" ");
            nested.className = classes || undefined;
            outNodes.push(nested);
          }
          y += height + GAP_Y;
        } else if (expanded && t.kind === "team") {
          // Expanded but layout still computing — placeholder compound.
          const notes = t.exec?.teamNotes;
          const notesFooter =
            (notes?.length ?? 0) > 0 ? TURN_GROUP_NOTES_FOOTER_H : 0;
          const width = TURN_GROUP_FALLBACK_W;
          const height = TURN_GROUP_FALLBACK_H + notesFooter;
          const groupX = -(width / 2);
          const groupData: TurnGroupData = {
            messageId: t.id,
            taskSummary: t.exec?.taskSummary || t.prompt || "团队回合",
            pendingDecisions: t.pendingDecisions,
            recoverable: t.recoverable,
            onMaximize: () => maximizeTurn(t.id),
            onCollapse: () => onCollapseTurn(t.id),
            teamNotes: notes,
            status: t.exec?.status,
          };
          outNodes.push({
            id: t.id,
            type: "turnGroup",
            position: { x: groupX, y },
            style: { width, height },
            data: groupData,
            draggable: false,
            zIndex: 0,
          });
          if (t.id === effectiveFocus) {
            groupOrigin = { x: groupX, y, width, height };
          }
          y += height + GAP_Y;
        } else if (t.kind === "team") {
          const exec = t.exec;
          const noteCount = exec?.teamNotes.length ?? 0;
          const data: TurnSummaryData = {
            taskSummary: exec?.taskSummary || t.prompt || "团队回合",
            status: exec?.status ?? "planning",
            roles: exec ? dedupeRoles(exec) : [],
            agentCount: exec?.agents.length ?? 0,
            completed: exec?.progress.completed ?? 0,
            total: exec?.progress.total ?? 0,
            pendingDecisions: t.pendingDecisions,
            recoverable: t.recoverable,
            noteCount,
          };
          outNodes.push({
            id: t.id,
            type: "teamTurn",
            position: { x: -(TURN_NODE_WIDTH / 2), y },
            data,
            draggable: false,
          });
          y += TEAM_NODE_HEIGHT + (noteCount > 0 ? 28 : 0) + GAP_Y;
        } else {
          const data: SimpleTurnData = {
            prompt: t.prompt,
            answer: t.answer,
            running: t.running,
            enter:
              t.id === lastTurnId &&
              !firstSpineRef.current &&
              !seenTurnsRef.current.has(t.id),
          };
          outNodes.push({
            id: t.id,
            type: "simpleTurn",
            position: { x: -(TURN_NODE_WIDTH / 2), y },
            data,
            draggable: false,
          });
          y += SIMPLE_NODE_HEIGHT + GAP_Y;
        }
      }

      for (const t of turnsNow) seenTurnsRef.current.add(t.id);
      firstSpineRef.current = false;

      for (let i = 1; i < turnsNow.length; i++) {
        outEdges.push({
          id: `${turnsNow[i - 1].id}->${turnsNow[i].id}`,
          source: turnsNow[i - 1].id,
          target: turnsNow[i].id,
          type: "smoothstep",
          selectable: false,
          style: { stroke: "var(--border)" },
        });
      }

      return {
        layoutNodes: outNodes,
        layoutEdges: outEdges,
        focusedGroupOrigin: groupOrigin,
        focusedWaves: waves,
        focusedDebateBands: debateBands,
      };
    }, [
      turnSpineKey,
      expandedKey,
      projectedReadyKey,
      effectiveFocus,
      projectedByTurn,
      turnLayouts,
      expandedTurnSet,
      maximizeTurn,
      onCollapseTurn,
      morphing,
      keyboardFocusId,
      effectiveLayoutKind,
    ]);

  // Patch presentation data onto layout-stable nodes.
  const baseNodes = useMemo(() => {
    const turnById = new Map(turns.map((t) => [t.id, t]));
    return layoutNodes.map((n) => {
      if (n.type === "turnGroup") {
        const t = turnById.get(n.id);
        if (!t) return n;
        const prev = n.data as TurnGroupData;
        const nextNotes = t.exec?.teamNotes;
        const next: TurnGroupData = {
          ...prev,
          taskSummary: t.exec?.taskSummary || t.prompt || "团队回合",
          pendingDecisions: t.pendingDecisions,
          recoverable: t.recoverable,
          teamNotes: nextNotes,
          status: t.exec?.status,
        };
        if (
          prev.taskSummary === next.taskSummary &&
          prev.pendingDecisions === next.pendingDecisions &&
          prev.recoverable === next.recoverable &&
          prev.status === next.status &&
          prev.teamNotes === nextNotes
        ) {
          return n;
        }
        return { ...n, data: next };
      }
      if (n.type === "teamTurn") {
        const t = turnById.get(n.id);
        if (!t) return n;
        const exec = t.exec;
        const next: TurnSummaryData = {
          taskSummary: exec?.taskSummary || t.prompt || "团队回合",
          status: exec?.status ?? "planning",
          roles: exec ? dedupeRoles(exec) : [],
          agentCount: exec?.agents.length ?? 0,
          completed: exec?.progress.completed ?? 0,
          total: exec?.progress.total ?? 0,
          pendingDecisions: t.pendingDecisions,
          recoverable: t.recoverable,
          noteCount: exec?.teamNotes.length ?? 0,
        };
        const prev = n.data as TurnSummaryData;
        if (
          prev.taskSummary === next.taskSummary &&
          prev.status === next.status &&
          prev.completed === next.completed &&
          prev.total === next.total &&
          prev.pendingDecisions === next.pendingDecisions &&
          prev.recoverable === next.recoverable &&
          prev.agentCount === next.agentCount &&
          prev.noteCount === next.noteCount
        ) {
          return n;
        }
        return { ...n, data: next };
      }
      if (n.type === "simpleTurn") {
        const t = turnById.get(n.id);
        if (!t) return n;
        const prev = n.data as SimpleTurnData;
        if (
          prev.prompt === t.prompt &&
          prev.answer === t.answer &&
          prev.running === t.running
        ) {
          return n;
        }
        return {
          ...n,
          data: {
            ...prev,
            prompt: t.prompt,
            answer: t.answer,
            running: t.running,
          } satisfies SimpleTurnData,
        };
      }
      // Nested DAG child — patch from that turn's presentation map.
      const sep = n.id.indexOf("::");
      if (sep < 0) return n;
      const turnId = n.id.slice(0, sep);
      const bare = n.id.slice(sep + 2);
      const present = projectedByTurn.get(turnId)?.presentData;
      const freshData = present?.get(bare);
      if (!freshData || freshData === n.data) return n;
      return { ...n, data: freshData };
    });
  }, [layoutNodes, turns, projectedByTurn]);

  const baseEdges = useMemo(() => {
    const spineEdges = layoutEdges.filter((e) => e.type === "smoothstep");
    const nested: Edge[] = [];
    for (const [turnId, proj] of projectedByTurn) {
      for (const e of proj.edges) {
        nested.push({
          ...e,
          id: `${turnId}::${e.id}`,
          source: nestEndpoint(e.source, turnId),
          target: nestEndpoint(e.target, turnId),
        });
      }
    }
    return [...nested, ...spineEdges];
  }, [layoutEdges, projectedByTurn]);

  const nodes = baseNodes;

  const hoverState = useMemo(() => {
    const injectRelated = injectOverlay?.dimUnrelatedEdges
      ? injectOverlay.relatedNodeIds
      : null;
    const injectRelatedNamespaced =
      injectRelated && effectiveFocus
        ? new Set(
            [...injectRelated].flatMap((id) => [
              id,
              `${effectiveFocus}::${id}`,
            ]),
          )
        : injectRelated;

    const hoverRelated = hoveredNodeId
      ? hoverRelatedIds(
          hoveredNodeId,
          baseEdges.map((e) => ({ source: e.source, target: e.target })),
        )
      : null;

    return {
      hoveredNodeId,
      keepBrightIds: computeKeepBrightIds(
        hoverRelated,
        injectRelatedNamespaced,
      ),
    };
  }, [baseEdges, hoveredNodeId, injectOverlay, effectiveFocus]);

  const edges = baseEdges;

  const canvasWaves = useMemo<WaveBand[]>(() => {
    if (!focusedGroupOrigin || focusedWaves.length === 0) return [];
    const ox = focusedGroupOrigin.x + TURN_GROUP_PAD;
    const oy = focusedGroupOrigin.y + TURN_GROUP_HEADER_H + TURN_GROUP_PAD;
    return focusedWaves.map((w) => ({
      ...w,
      x: w.x + ox,
      y: w.y + oy,
      labelX: w.labelX + ox,
      labelY: w.labelY + oy,
    }));
  }, [focusedWaves, focusedGroupOrigin]);

  const canvasDebateBands = useMemo<WaveBand[]>(() => {
    if (!focusedGroupOrigin || focusedDebateBands.length === 0) return [];
    const ox = focusedGroupOrigin.x + TURN_GROUP_PAD;
    const oy = focusedGroupOrigin.y + TURN_GROUP_HEADER_H + TURN_GROUP_PAD;
    return focusedDebateBands.map((b) => ({
      ...b,
      x: b.x + ox,
      y: b.y + oy,
      labelX: b.labelX + ox,
      labelY: b.labelY + oy,
    }));
  }, [focusedDebateBands, focusedGroupOrigin]);

  const focusedSlice = effectiveFocus ? turnLayouts[effectiveFocus] : null;

  const activateCanvasNode = useCallback(
    (nodeId: string) => {
      if (turns.some((t) => t.id === nodeId)) return;
      const sep = nodeId.indexOf("::");
      const turnId = sep < 0 ? effectiveFocus : nodeId.slice(0, sep);
      const raw = sep < 0 ? nodeId : nodeId.slice(sep + 2);
      if (turnId && turnId !== effectiveFocus) {
        // Activate within non-focus expanded turn: open run detail there.
        const t = turns.find((x) => x.id === turnId);
        if (t?.exec) {
          const run = t.exec.runs.find((r) => r.id === raw);
          const role = t.exec.agents.find((a) => a.id === run?.agentId)?.role;
          showRunDetail(turnId, raw, role);
        }
        return;
      }
      activateNode(raw);
    },
    [activateNode, turns, effectiveFocus, showRunDetail],
  );

  // Keyboard navigation among agent nodes in the focused turn.
  const navigableNodeIds = useMemo(() => {
    if (!effectiveFocus) return [] as string[];
    const proj = projectedByTurn.get(effectiveFocus);
    if (!proj) return [];
    return proj.layoutNodes
      .filter((n) => n.type === "agent")
      .map((n) => `${effectiveFocus}::${n.id}`);
  }, [effectiveFocus, projectedByTurn]);

  const handleKeyboardNav = useCallback(
    (key: string): boolean => {
      if (navigableNodeIds.length === 0) return false;
      if (key === "Escape") {
        setKeyboardFocusId(null);
        return true;
      }
      if (key === "Enter" && keyboardFocusId) {
        activateCanvasNode(keyboardFocusId);
        return true;
      }
      const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
      if (!arrows.includes(key)) return false;
      const idx = keyboardFocusId
        ? navigableNodeIds.indexOf(keyboardFocusId)
        : -1;
      let next = idx;
      if (key === "ArrowDown" || key === "ArrowRight") {
        next = idx < 0 ? 0 : Math.min(idx + 1, navigableNodeIds.length - 1);
      } else {
        next = idx < 0 ? 0 : Math.max(idx - 1, 0);
      }
      setKeyboardFocusId(navigableNodeIds[next] ?? null);
      return true;
    },
    [navigableNodeIds, keyboardFocusId, activateCanvasNode],
  );

  const layoutReady =
    !effectiveFocus || !focusedExec || (focusedSlice?.layoutReady ?? false);
  const layoutError = focusedSlice?.layoutError ?? null;

  return {
    nodes,
    edges,
    layoutReady,
    layoutError,
    onNodesChange,
    focusedExec,
    effectiveLayoutKind,
    waves: canvasWaves,
    debateBands: canvasDebateBands,
    bbox: focusedSlice?.bbox ?? null,
    layoutKind,
    setLayoutKind,
    metricsSummary,
    injectFlowAvailable,
    showAuditInjectFlow,
    setShowAuditInjectFlow,
    injectOverlay,
    hoverState,
    hoveredNodeId,
    setHoveredNodeId,
    menuNodeId,
    setMenuNodeId,
    activateCanvasNode,
    showRunDetailHere,
    captainRun,
    finalAnswer,
    taskMessage,
    litRunId,
    onExpandTurn,
    onCollapseTurn,
    handleKeyboardNav,
    keyboardFocusId,
  };
}
