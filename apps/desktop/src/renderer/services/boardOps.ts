import { notifyInfo } from "@/lib/toast";
import { ApiError } from "@/services/api";
import { resolveInteraction } from "@/services/interaction";
import type { BoardOp, BoardOpRequiredPayload } from "@/types/events";

/**
 * Desktop half of the whiteboard op channel (AI协作白板.md §六 M2).
 *
 * When the server-side `board_ops` tool needs to draw on the user's open canvas it
 * streams a `board_op_required` event; the open `WhiteboardCanvasPage` registers an
 * applier (keyed by board id) that converts the ops to Excalidraw elements, applies
 * them, CAS-saves, and reports back. We settle the paused op over the unified
 * interaction bridge (kind `client_tool`), so the live SSE turn resumes.
 *
 * Failure policy: the channel must always answer (or the server-side op only ends on
 * its timeout). If the board's canvas is not open (no applier registered), we resolve a
 * clean error so the tool reports「画布未打开」instead of the turn hanging. A stale
 * request (404) is a no-op.
 */

/** What the canvas applier returns after applying a batch (rides the resolve回执). */
export interface BoardApplyResult {
  applied: number;
  created: string[];
  version: number;
}

type BoardApplier = (ops: BoardOp[]) => Promise<BoardApplyResult>;

// board_id → the open canvas's applier. At most one canvas per board is open, so the
// last registration wins; unregister is identity-checked so a stale unmount can't evict
// a newer mount's applier.
const _appliers = new Map<string, BoardApplier>();

/** The open canvas registers its applier; returns an unregister for cleanup on unmount. */
export function registerBoardApplier(
  boardId: string,
  applier: BoardApplier,
): () => void {
  _appliers.set(boardId, applier);
  return () => {
    if (_appliers.get(boardId) === applier) _appliers.delete(boardId);
  };
}

export async function performBoardOp(
  payload: BoardOpRequiredPayload,
  conversationId: string,
): Promise<void> {
  const result = await runBoardOps(payload);
  // Visible feedback that the AI just drew (the canvas has no chat surface): the model's
  // one-line summary, or a generic notice. Only on success — a failure settles silently
  // and the tool result tells the model the ops didn't land.
  if (result.ok) {
    notifyInfo(payload.summary?.trim() || "AI 已更新白板");
  }
  try {
    await resolveInteraction(conversationId, payload.request_id, {
      kind: "client_tool",
      ...result,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return; // stale — no-op
    console.error("[boardOps] 回填失败", err);
  }
}

type ClientToolResult =
  | { ok: true; value: BoardApplyResult }
  | { ok: false; error: { kind: string; detail: string } };

function boardError(detail: string): ClientToolResult {
  return { ok: false, error: { kind: "BoardOpError", detail } };
}

async function runBoardOps(
  payload: BoardOpRequiredPayload,
): Promise<ClientToolResult> {
  const applier = _appliers.get(payload.board_id);
  if (!applier) {
    return boardError("该白板未在前台打开，无法作画");
  }
  try {
    const value = await applier(payload.ops ?? []);
    return { ok: true, value };
  } catch (e) {
    return boardError(e instanceof Error ? e.message : String(e));
  }
}

// --- pure converters (ops → Excalidraw) -------------------------------------
//
// Kept free of any `@excalidraw/excalidraw` import so they unit-test without loading
// the editor: the canvas page feeds `buildNodeSkeletons(...)` to `convertToExcalidraw
// Elements` and applies `applyExistingEdits(...)` to the live scene.

/** A minimal Excalidraw skeleton (the subset of fields we emit); the page casts it to
 * the editor's `ExcalidrawElementSkeleton` for `convertToExcalidrawElements`. */
export type BoardSkeleton =
  | {
      type: "rectangle" | "ellipse" | "diamond";
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      backgroundColor?: string;
      strokeColor?: string;
      label?: { text: string };
    }
  | {
      type: "text";
      id: string;
      x: number;
      y: number;
      text: string;
      strokeColor?: string;
    }
  | {
      type: "arrow";
      x: number;
      y: number;
      start: { id: string };
      end: { id: string };
      label?: { text: string };
    };

/** A loosely-typed live scene element (the page casts Excalidraw's element to this). */
export interface BoardElement {
  id: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  groupIds?: string[];
  boundElements?: { id: string; type: string }[] | null;
  isDeleted?: boolean;
  [k: string]: unknown;
}

/** The brand-new node ids of a batch plus the skeletons to feed the converter. */
export interface SkeletonBatch {
  skeletons: BoardSkeleton[];
  /** Ids of nodes CREATED this batch (excludes arrows + passthrough endpoints), in op
   * order — the回执's `created`. Stable because the converter keeps them (regenerateIds:
   * false), so they are the real scene ids. */
  createdIds: string[];
  /** Maps each AI-chosen `ref` to the generated element id, so later ops in the batch that
   * reference a new node by `ref` (e.g. `group`) can resolve it to its real scene id. */
  refToId: ReadonlyMap<string, string>;
}

const _STICKY_BG = "#ffec99";
const _NODE_W = 180;
const _NODE_H = 90;
// Excalidraw shapes an arrow can bind to (the transform's ValidLinearElement excludes
// text / image / frames), so a `connect` to an existing element only binds to these.
const _BINDABLE = new Set(["rectangle", "ellipse", "diamond"]);

/** A fresh, collision-proof id for a newly-created node. Preserved through
 * `convertToExcalidrawElements(…, { regenerateIds: false })`, so it becomes the element's
 * real scene id — distinct from every existing id, which is exactly what lets the merge
 * tell a new node apart from a bound-to existing endpoint. */
function _newElementId(): string {
  return `brd-${crypto.randomUUID()}`;
}

/** Lay out a node with no explicit position into a tidy 4-wide cascade so an AI batch
 * that omits coordinates still produces a readable diagram instead of a pile at 0,0. */
function _autoPos(index: number): { x: number; y: number } {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return { x: 120 + col * 240, y: 120 + row * 160 };
}

/**
 * Build the skeleton batch for the `add_node` / `connect` ops, ready for
 * `convertToExcalidrawElements(…, { regenerateIds: false })`.
 *
 * Each `add_node` gets a fresh unique id; its `ref` is remembered so a `connect` in the
 * SAME batch wires to it. A `connect` endpoint resolves to either such a new node OR an
 * EXISTING bindable scene element (`existing`) — for the latter we emit a *passthrough*
 * skeleton (the live element's id + geometry) so the converter can bind the arrow to the
 * real element; the page then merges only the resulting `boundElements` back (so the live
 * element keeps all its own props). A connect whose endpoint resolves to neither — or to a
 * non-bindable shape (text / image / frame) — is skipped.
 */
export function buildNodeSkeletons(
  ops: BoardOp[],
  existing?: ReadonlyMap<string, BoardElement>,
): SkeletonBatch {
  const skeletons: BoardSkeleton[] = [];
  const createdIds: string[] = [];
  const refToId = new Map<string, string>();
  let nodeIndex = 0;
  for (const op of ops) {
    if (op.op !== "add_node") continue;
    const id = _newElementId();
    createdIds.push(id);
    if (op.ref) refToId.set(op.ref, id);
    const pos = {
      x: op.x ?? _autoPos(nodeIndex).x,
      y: op.y ?? _autoPos(nodeIndex).y,
    };
    nodeIndex++;
    const kind = op.kind || "sticky";
    if (kind === "text") {
      skeletons.push({
        type: "text",
        id,
        x: pos.x,
        y: pos.y,
        text: op.text || "",
        strokeColor: op.color,
      });
      continue;
    }
    const shape = kind === "sticky" ? "rectangle" : kind;
    skeletons.push({
      type: shape,
      id,
      x: pos.x,
      y: pos.y,
      width: op.width ?? _NODE_W,
      height: op.height ?? _NODE_H,
      backgroundColor: kind === "sticky" ? op.color || _STICKY_BG : op.color,
      strokeColor: kind === "sticky" ? undefined : op.color,
      label: op.text ? { text: op.text } : undefined,
    });
  }

  // Resolve a connect endpoint to a real element id, emitting a passthrough skeleton (once)
  // for an existing bindable shape so the converter can bind to it. Returns null when the
  // endpoint is neither a same-batch ref nor a bindable existing element.
  const passthroughs = new Set<string>();
  const resolveEndpoint = (endpoint: string): string | null => {
    const created = refToId.get(endpoint);
    if (created) return created;
    const el = existing?.get(endpoint);
    if (
      !el ||
      !_BINDABLE.has(el.type ?? "") ||
      typeof el.x !== "number" ||
      typeof el.y !== "number"
    ) {
      return null;
    }
    if (!passthroughs.has(endpoint)) {
      passthroughs.add(endpoint);
      skeletons.push({
        type: el.type as "rectangle" | "ellipse" | "diamond",
        id: endpoint,
        x: el.x,
        y: el.y,
        width: typeof el.width === "number" ? el.width : _NODE_W,
        height: typeof el.height === "number" ? el.height : _NODE_H,
      });
    }
    return endpoint;
  };

  for (const op of ops) {
    if (op.op !== "connect" || !op.from || !op.to) continue;
    const from = resolveEndpoint(op.from);
    const to = resolveEndpoint(op.to);
    if (!from || !to) continue;
    skeletons.push({
      type: "arrow",
      x: 0,
      y: 0,
      start: { id: from },
      end: { id: to },
      label: op.label ? { text: op.label } : undefined,
    });
  }
  return { skeletons, createdIds, refToId };
}

/**
 * Merge a `convertToExcalidrawElements` result back onto the edited scene.
 *
 * `converted` holds three kinds of element: brand-new nodes, the arrows (+ any arrow-label
 * text), and *passthrough* copies of existing endpoints (same id as a live element, now
 * carrying the freshly-added arrow in `boundElements`). New elements are appended; a
 * passthrough is NOT re-added — its `boundElements` are merged onto the real element so it
 * keeps every property of its own (label, style, position…) and only learns about the new
 * arrow. Returns a new array; inputs are untouched.
 */
export function mergeAppliedScene(
  edited: readonly BoardElement[],
  converted: readonly BoardElement[],
): BoardElement[] {
  const currentIds = new Set(edited.map((e) => e.id));
  const passthroughById = new Map<string, BoardElement>();
  const additions: BoardElement[] = [];
  for (const el of converted) {
    if (currentIds.has(el.id)) passthroughById.set(el.id, el);
    else additions.push(el);
  }
  const merged = edited.map((el) => {
    const extraBounds = passthroughById.get(el.id)?.boundElements;
    if (!extraBounds?.length) return el;
    const seen = new Set((el.boundElements ?? []).map((b) => b.id));
    const extra = extraBounds.filter((b) => !seen.has(b.id));
    if (extra.length === 0) return el;
    return { ...el, boundElements: [...(el.boundElements ?? []), ...extra] };
  });
  return [...merged, ...additions];
}

/**
 * Apply `move` / `set_text` / `delete` ops that target EXISTING scene elements by `id`.
 *
 * Returns a NEW element array (copies of the touched elements; deletions removed). Ops
 * whose target id isn't in the scene are skipped (a brand-new `ref` is created via
 * `buildNodeSkeletons`, not edited here). `set_text` applies to text elements; a
 * container's bound label isn't rewritten in M2.
 */
export function applyExistingEdits(
  elements: readonly BoardElement[],
  ops: BoardOp[],
): BoardElement[] {
  const byId = new Map(elements.map((el) => [el.id, { ...el }]));
  const deleted = new Set<string>();
  for (const op of ops) {
    const target = op.id;
    if (!target) continue;
    const el = byId.get(target);
    if (!el) continue;
    if (op.op === "delete") {
      deleted.add(target);
    } else if (op.op === "move") {
      if (typeof op.x === "number") el.x = op.x;
      if (typeof op.y === "number") el.y = op.y;
    } else if (op.op === "set_text" && el.type === "text") {
      el.text = op.text || "";
    }
  }
  return [...byId.values()].filter((el) => !deleted.has(el.id));
}

/**
 * Apply `group` ops by stamping a shared groupId onto each resolvable member.
 *
 * Mutates the passed element array in place (called on the FINAL set — existing edits +
 * newly-converted nodes). A member is a `ref` (a node created THIS batch — resolved to its
 * generated id via `refToId`) or an existing element's real id; one that resolves to no
 * element is skipped.
 */
export function applyGroups(
  elements: BoardElement[],
  ops: BoardOp[],
  refToId?: ReadonlyMap<string, string>,
): void {
  const byId = new Map(elements.map((el) => [el.id, el]));
  let seq = 0;
  for (const op of ops) {
    if (op.op !== "group" || !op.members?.length) continue;
    const groupId = `grp-${Date.now()}-${seq++}`;
    for (const member of op.members) {
      const el = byId.get(refToId?.get(member) ?? member);
      if (el) el.groupIds = [...(el.groupIds ?? []), groupId];
    }
  }
}
