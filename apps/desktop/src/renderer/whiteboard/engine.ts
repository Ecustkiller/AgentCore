/**
 * WhiteboardEngine — the self-built canvas core (AI协作白板.md §六 自研引擎架构).
 *
 * Owns the scene, viewport, pointer/keyboard interaction, history, and a text-edit
 * overlay; renders via {@link renderScene}. Framework-agnostic — {@link WhiteboardCanvas}
 * is a thin React shell. Mutations funnel through history so undo/redo stays consistent;
 * pan/zoom do NOT fire `onChange` (so navigation never triggers autosave).
 */

import type { BoardOp } from "@/types/events";
import { cloneElements } from "./clone";
import { type Palette, readPalette } from "./colors";
import { smoothFreedraw } from "./freedrawSmooth";
import {
  type Box,
  boxesIntersect,
  elementBox,
  hitTestElement,
  isLinear,
  screenToWorld,
  unionBox,
} from "./geometry";
import { History } from "./history";
import { ImageCache, loadImageForImport } from "./images";
import { layoutGrid } from "./layout";
import { applyBoardOps } from "./ops";
import { handlePositions, renderScene } from "./render";
import * as selOps from "./selectionOps";
import { computeMoveSnap as snapMove } from "./snap";
import { type TextCommit, TextEditor } from "./textEditor";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  SCENE_SCHEMA_VERSION,
  type SceneElement,
  type Tool,
  type Viewport,
} from "./types";

export interface EngineCallbacks {
  /** A committed element mutation (host autosaves). NOT called for pan/zoom. */
  onChange: () => void;
  onSelectionChange: (ids: string[]) => void;
  onToolChange: (tool: Tool) => void;
  onViewportChange: (zoom: number) => void;
  /** Right-click on the canvas (screen px, relative to the canvas) — host opens a menu. */
  onContextMenu: (x: number, y: number) => void;
}

type Pointer =
  | { kind: "idle" }
  | { kind: "pan"; sx: number; sy: number; panX: number; panY: number }
  | { kind: "marquee"; start: [number, number]; additive: boolean }
  | { kind: "move"; last: [number, number] }
  | { kind: "create"; id: string; origin: [number, number] }
  | { kind: "freedraw"; id: string }
  | { kind: "arrowdraw"; id: string; origin: [number, number] }
  | { kind: "resize"; id: string; handle: string; box: Box }
  | { kind: "scale"; handle: string; box: Box; base: SceneElement[] }
  | { kind: "erase" };

const HANDLE_HIT = 10;
const CLICK_SLOP = 4;
const DEFAULT_W = 140;
const DEFAULT_H = 84;
/** Initial longest-side (world units) for a pasted / dropped image — a comfortable default
 * the user can then resize. Distinct from the data URL's pixel cap (images.ts MAX_IMAGE_DIM). */
const IMAGE_PLACE = 360;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const NUDGE = 1;
const NUDGE_LARGE = 10;
const PASTE_OFFSET = 16;

/** Single-key tool shortcuts (no modifier). `d`/`a` only pick a tool here — Ctrl+D / Ctrl+A
 * are duplicate / select-all, handled before this map is consulted. */
const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  h: "hand",
  r: "rectangle",
  o: "ellipse",
  d: "diamond",
  s: "sticky",
  t: "text",
  a: "arrow",
  l: "line",
  f: "frame",
  p: "freedraw",
  e: "eraser",
};

/** Recompute an arrow's bbox (x/y/width/height) from its world points, so selection +
 * marquee work. Rendering uses the points/bindings directly; the box is bookkeeping. */
function syncArrowBox(el: SceneElement): void {
  const pts = el.points;
  if (!pts || pts.length === 0) return;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [px, py] of pts) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  el.x = minX;
  el.y = minY;
  el.width = maxX - minX;
  el.height = maxY - minY;
}

export class WhiteboardEngine {
  private elements: SceneElement[] = [];
  /** Transient AI-progress overlay (AI协作白板 M3 进度贴源): drawn ON TOP of the scene but
   * NOT part of it — excluded from history / serialize / onChange / hit-testing. The host
   * rebuilds it from the live run tree; {@link setOverlay} swaps it. */
  private overlay: SceneElement[] = [];
  private viewport: Viewport = { panX: 0, panY: 0, zoom: 1 };
  private selected = new Set<string>();
  private tool: Tool = "select";
  private palette: Palette;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly history = new History();
  private readonly images = new ImageCache(() => this.scheduleRender());

  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  private pointer: Pointer = { kind: "idle" };
  private dragBefore: SceneElement[] | null = null;
  private dragDirty = false;
  private spaceDown = false;
  private marquee: Box | null = null;
  private rafId = 0;
  private clipboard: SceneElement[] = [];
  private guides: Array<[number, number, number, number]> = [];
  private readonly textEditor: TextEditor;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
    private readonly cb: EngineCallbacks,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 2D 画布上下文");
    this.ctx = ctx;
    this.palette = readPalette();
    this.textEditor = new TextEditor({
      container,
      getViewport: () => this.viewport,
      onCommitText: (c) => this.commitText(c),
      requestRender: () => this.scheduleRender(),
    });
    this.bind();
  }

  // --- lifecycle -----------------------------------------------------------

  private bind(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.canvas.addEventListener("dragover", this.onDragOver);
    this.canvas.addEventListener("drop", this.onDrop);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("paste", this.onPaste);
  }

  destroy(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("dragover", this.onDragOver);
    this.canvas.removeEventListener("drop", this.onDrop);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("paste", this.onPaste);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.textEditor.destroy();
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.scheduleRender();
  }

  setDark(): void {
    this.palette = readPalette();
    this.scheduleRender();
  }

  // --- public API ----------------------------------------------------------

  setTool(tool: Tool): void {
    this.tool = tool;
    this.cb.onToolChange(tool);
    this.updateCursor();
  }

  getTool(): Tool {
    return this.tool;
  }

  getScene(): SceneElement[] {
    return this.elements;
  }

  getViewport(): Viewport {
    return { ...this.viewport };
  }

  getSelectedIds(): string[] {
    return [...this.selected];
  }

  /** Whether the current selection holds at least one element of `type` — the host shows the M3
   * 迭代 (贴源迭代) affordance only when an `artifactCard` (a crystallized product) is selected. */
  hasSelectedType(type: SceneElement["type"]): boolean {
    return this.elements.some(
      (e) => this.selected.has(e.id) && e.type === type,
    );
  }

  /** Bounding box (world) of the current selection — the host anchors the M3 live-progress
   * overlay beside it (进度贴源). Null when nothing is selected. */
  getSelectionBounds(): Box | null {
    return unionBox(this.elements.filter((e) => this.selected.has(e.id)));
  }

  /** Replace the transient AI-progress overlay layer (M3 进度贴源). These elements render on
   * top of the scene but live entirely outside it — never serialized, never pushed to history,
   * never hit-tested / selectable. `[]` clears the layer. */
  setOverlay(elements: SceneElement[]): void {
    this.overlay = elements;
    this.scheduleRender();
  }

  /** Append persistent elements to the scene as one history step + change (M3 产物回贴): the
   * crystallized team cards become real, undoable, serialized scene content (vs the transient
   * {@link setOverlay} layer). Clones the input so the caller's array never aliases the scene;
   * leaves the selection untouched so it doesn't yank focus off what the user was doing. */
  addElements(elements: SceneElement[]): void {
    if (elements.length === 0) return;
    const before = this.elements;
    this.elements = [...before, ...cloneElements(elements)];
    this.history.push(before);
    this.emitChange();
  }

  /**
   * Rasterize a subset of elements (by id) to a PNG — the host hands this to the AI's
   * vision reader for `board_read` (AI协作白板.md §九 混合 payload: 只有手绘 / 截图子集才走视觉).
   * Renders the chosen elements alone onto an offscreen canvas under a synthetic viewport
   * (no selection chrome), capped at {@link MAX_RASTER} px on the long side (§九.2 体积护栏).
   * Throws if no element matches — the host maps that to a clean board_read failure.
   */
  rasterizeElements(ids: string[]): {
    pngBase64: string;
    w: number;
    h: number;
  } {
    const want = new Set(ids);
    const subset = this.elements.filter((e) => want.has(e.id));
    const bbox = unionBox(subset);
    if (!bbox) throw new Error("没有可读取的元素（选区为空或 id 不存在）");

    const PAD = 12; // world units of breathing room around the content
    const x0 = bbox.x - PAD;
    const y0 = bbox.y - PAD;
    const worldW = bbox.width + PAD * 2;
    const worldH = bbox.height + PAD * 2;

    const MAX_RASTER = 1024;
    const scale = Math.min(1, MAX_RASTER / Math.max(worldW, worldH));
    const w = Math.max(1, Math.round(worldW * scale));
    const h = Math.max(1, Math.round(worldH * scale));

    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const offCtx = off.getContext("2d");
    if (!offCtx) throw new Error("无法创建离屏画布上下文");

    renderScene({
      ctx: offCtx,
      width: w,
      height: h,
      dpr: 1,
      viewport: { panX: -x0 * scale, panY: -y0 * scale, zoom: scale },
      elements: subset,
      palette: this.palette,
      selectedIds: new Set(),
      editingId: null,
      marquee: null,
      images: this.images,
    });

    const url = off.toDataURL("image/png");
    return { pngBase64: url.slice(url.indexOf(",") + 1), w, h };
  }

  loadScene(elements: SceneElement[], viewport?: Viewport): void {
    this.textEditor.commit();
    this.elements = cloneElements(elements);
    this.viewport = viewport ?? { panX: 0, panY: 0, zoom: 1 };
    this.selected.clear();
    this.history.clear();
    this.cb.onSelectionChange([]);
    this.cb.onViewportChange(this.viewport.zoom);
    this.scheduleRender();
  }

  applyOps(ops: BoardOp[]): { created: string[] } {
    const before = this.elements;
    const { elements, created } = applyBoardOps(before, ops);
    this.elements = elements;
    this.history.push(before);
    this.reconcileSelection();
    this.emitChange();
    return { created };
  }

  undo(): void {
    const restored = this.history.undo(this.elements);
    if (!restored) return;
    this.textEditor.commit();
    this.elements = restored;
    this.reconcileSelection();
    this.emitChange();
  }

  redo(): void {
    const restored = this.history.redo(this.elements);
    if (!restored) return;
    this.textEditor.commit();
    this.elements = restored;
    this.reconcileSelection();
    this.emitChange();
  }

  deleteSelected(): void {
    if (this.selected.size === 0) return;
    const before = this.elements;
    const ids = new Set(
      [...this.selected].filter((id) => {
        const el = before.find((e) => e.id === id);
        return el && !el.locked;
      }),
    );
    if (ids.size === 0) return;
    this.elements = before.filter(
      (e) =>
        !ids.has(e.id) &&
        !(
          e.type === "arrow" &&
          ((e.start?.id && ids.has(e.start.id)) ||
            (e.end?.id && ids.has(e.end.id)))
        ),
    );
    this.history.push(before);
    this.selected.clear();
    this.cb.onSelectionChange([]);
    this.emitChange();
  }

  zoomIn(): void {
    this.zoomAt(1.2, this.cssW / 2, this.cssH / 2);
  }

  zoomOut(): void {
    this.zoomAt(1 / 1.2, this.cssW / 2, this.cssH / 2);
  }

  resetZoom(): void {
    this.zoomAt(1 / this.viewport.zoom, this.cssW / 2, this.cssH / 2);
  }

  zoomToFit(): void {
    this.zoomToBox(unionBox(this.elements));
  }

  /** Frame the current selection in the viewport (Ctrl+2). */
  zoomToSelection(): void {
    const box = unionBox(this.elements.filter((e) => this.selected.has(e.id)));
    this.zoomToBox(box);
  }

  private zoomToBox(box: Box | null): void {
    if (!box || box.width === 0 || box.height === 0) {
      this.resetZoom();
      return;
    }
    const pad = 80;
    const zoom = clamp(
      Math.min(
        (this.cssW - pad * 2) / box.width,
        (this.cssH - pad * 2) / box.height,
      ),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    this.viewport.zoom = zoom;
    this.viewport.panX = this.cssW / 2 - (box.x + box.width / 2) * zoom;
    this.viewport.panY = this.cssH / 2 - (box.y + box.height / 2) * zoom;
    this.cb.onViewportChange(zoom);
    this.scheduleRender();
  }

  /** Download the current selection as a PNG file. */
  exportSelectionPng(): void {
    const ids = [...this.selected];
    if (ids.length === 0) return;
    const { pngBase64 } = this.rasterizeElements(ids);
    const a = document.createElement("a");
    a.href = `data:image/png;base64,${pngBase64}`;
    a.download = "whiteboard-selection.png";
    a.click();
  }

  // --- rendering -----------------------------------------------------------

  private scheduleRender(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.render();
    });
  }

  private render(): void {
    if (this.cssW === 0 || this.cssH === 0) return;
    renderScene({
      ctx: this.ctx,
      width: this.cssW,
      height: this.cssH,
      dpr: this.dpr,
      viewport: this.viewport,
      // Overlay (M3 进度贴源) draws last so it sits on top; it stays out of `this.elements`
      // so history / serialize / onChange / hit-testing never see it.
      elements: this.overlay.length
        ? [...this.elements, ...this.overlay]
        : this.elements,
      palette: this.palette,
      selectedIds: this.selected,
      editingId: this.textEditor.editingId,
      marquee: this.marquee,
      images: this.images,
      guides: this.guides,
    });
  }

  // --- helpers -------------------------------------------------------------

  private byId(): Map<string, SceneElement> {
    return new Map(this.elements.map((e) => [e.id, e]));
  }

  private emitChange(): void {
    this.cb.onChange();
    this.scheduleRender();
  }

  /** Swap in a transformed scene (from a {@link selOps} pure transform) as one history
   * step + change notification. `next` reuses untouched element refs, but {@link History}
   * deep-clones the snapshot, so the saved state never aliases the live scene. */
  private commit(next: SceneElement[]): void {
    const before = this.elements;
    this.elements = next;
    this.history.push(before);
    this.emitChange();
  }

  private reconcileSelection(): void {
    const ids = new Set(this.elements.map((e) => e.id));
    let changed = false;
    for (const id of this.selected) {
      if (!ids.has(id)) {
        this.selected.delete(id);
        changed = true;
      }
    }
    if (changed) this.cb.onSelectionChange([...this.selected]);
  }

  private toWorld(e: PointerEvent | WheelEvent | MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return screenToWorld(
      this.viewport,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
  }

  private toScreen(
    e: PointerEvent | WheelEvent | MouseEvent,
  ): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private topElementAt(wx: number, wy: number): SceneElement | null {
    const tol = 6 / this.viewport.zoom;
    const map = this.byId();
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const el = this.elements[i];
      if (el.locked) continue;
      if (hitTestElement(el, wx, wy, tol, map)) return el;
    }
    return null;
  }

  private handleAt(sx: number, sy: number): string | null {
    if (this.selected.size !== 1) return null;
    const only = this.elements.find((e) => this.selected.has(e.id));
    if (
      !only ||
      only.locked ||
      only.type === "arrow" ||
      only.type === "freedraw"
    )
      return null;
    const b = elementBox(only);
    const screenBox: Box = {
      x: b.x * this.viewport.zoom + this.viewport.panX,
      y: b.y * this.viewport.zoom + this.viewport.panY,
      width: b.width * this.viewport.zoom,
      height: b.height * this.viewport.zoom,
    };
    for (const h of handlePositions(screenBox)) {
      if (
        Math.abs(sx - h.x) <= HANDLE_HIT &&
        Math.abs(sy - h.y) <= HANDLE_HIT
      ) {
        return h.id;
      }
    }
    return null;
  }

  private setSelection(ids: string[]): void {
    this.selected = new Set(ids);
    this.cb.onSelectionChange(ids);
  }

  private updateCursor(hoverEl?: boolean, hoverHandle?: boolean): void {
    let cursor = "default";
    if (this.tool === "hand" || this.spaceDown) cursor = "grab";
    else if (this.tool === "eraser") cursor = "cell";
    else if (this.tool !== "select") cursor = "crosshair";
    else if (hoverHandle) cursor = "nwse-resize";
    else if (hoverEl) cursor = "move";
    this.canvas.style.cursor = cursor;
  }

  // --- pointer interaction -------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button === 1 || this.tool === "hand" || this.spaceDown) {
      this.pointer = {
        kind: "pan",
        sx: e.clientX,
        sy: e.clientY,
        panX: this.viewport.panX,
        panY: this.viewport.panY,
      };
      this.canvas.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0) return;
    this.textEditor.commit();
    const [wx, wy] = this.toWorld(e);
    const [sx, sy] = this.toScreen(e);

    if (this.tool === "text") {
      this.textEditor.begin(null, [wx, wy]);
      return;
    }

    if (this.tool === "arrow" || this.tool === "line") {
      this.startLinear(this.tool, wx, wy);
      return;
    }

    if (this.tool === "eraser") {
      this.dragBefore = cloneElements(this.elements);
      this.dragDirty = false;
      this.pointer = { kind: "erase" };
      this.eraseAt(wx, wy);
      return;
    }

    if (this.tool !== "select") {
      this.startCreate(wx, wy);
      return;
    }

    // select tool: a resize/scale handle takes priority over selecting what's under it.
    const handle = this.handleAt(sx, sy);
    if (handle) {
      this.dragBefore = cloneElements(this.elements);
      this.dragDirty = false;
      if (this.selected.size === 1) {
        const only = this.elements.find((el) => this.selected.has(el.id));
        if (only) {
          this.pointer = {
            kind: "resize",
            id: only.id,
            handle,
            box: elementBox(only),
          };
          return;
        }
      } else {
        const box = unionBox(
          this.elements.filter((e) => this.selected.has(e.id)),
        );
        if (box) {
          this.pointer = { kind: "scale", handle, box, base: this.dragBefore };
          return;
        }
      }
    }

    const hit = this.topElementAt(wx, wy);
    if (hit) {
      const members = selOps.withGroup(this.elements, [hit.id]);
      if (e.shiftKey) {
        const next = new Set(this.selected);
        const allIn = members.every((id) => next.has(id));
        for (const id of members) {
          if (allIn) next.delete(id);
          else next.add(id);
        }
        this.setSelection([...next]);
      } else if (!this.selected.has(hit.id)) {
        this.setSelection(members);
      }
      this.dragBefore = cloneElements(this.elements);
      this.dragDirty = false;
      // Alt-drag duplicates: drop in-place copies that become the dragged selection (one
      // history step covers the copy + the move). Shift (toggle-select) takes precedence.
      if (e.altKey && !e.shiftKey) {
        const copies = selOps.copyWithOffset(
          this.elements.filter((el) => this.selected.has(el.id)),
          0,
        );
        this.elements = [...this.elements, ...copies];
        this.setSelection(copies.map((c) => c.id));
        this.dragDirty = true;
      }
      this.pointer = { kind: "move", last: [wx, wy] };
    } else {
      if (!e.shiftKey) this.setSelection([]);
      this.pointer = { kind: "marquee", start: [wx, wy], additive: e.shiftKey };
    }
    this.scheduleRender();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.pointer;
    if (p.kind === "idle") {
      if (this.tool === "select") {
        const [sx, sy] = this.toScreen(e);
        const [wx, wy] = this.toWorld(e);
        this.updateCursor(!!this.topElementAt(wx, wy), !!this.handleAt(sx, sy));
      }
      return;
    }
    const [wx, wy] = this.toWorld(e);

    switch (p.kind) {
      case "pan": {
        this.viewport.panX = p.panX + (e.clientX - p.sx);
        this.viewport.panY = p.panY + (e.clientY - p.sy);
        this.scheduleRender();
        break;
      }
      case "marquee": {
        this.marquee = {
          x: Math.min(p.start[0], wx),
          y: Math.min(p.start[1], wy),
          width: Math.abs(wx - p.start[0]),
          height: Math.abs(wy - p.start[1]),
        };
        this.scheduleRender();
        break;
      }
      case "move": {
        let dx = wx - p.last[0];
        let dy = wy - p.last[1];
        if (dx === 0 && dy === 0) break;
        // Snap the moving selection to nearby element edges/centers; the guide overlay shows
        // the matched lines. Snap adjusts the applied delta so it stays a relative move.
        const snap = this.computeMoveSnap(dx, dy);
        dx = snap.dx;
        dy = snap.dy;
        this.guides = snap.guides;
        if (dx !== 0 || dy !== 0) {
          for (const el of this.elements) {
            if (!this.selected.has(el.id) || el.locked) continue;
            el.x += dx;
            el.y += dy;
            // Linear points are absolute world coords (freedraw's are relative to x/y, so they
            // ride along for free); translate them so a dragged unbound line keeps its shape.
            if (isLinear(el.type) && el.points) {
              el.points = el.points.map(
                ([px, py]) => [px + dx, py + dy] as [number, number],
              );
            }
          }
        }
        p.last = [wx, wy];
        this.dragDirty = true;
        this.scheduleRender();
        break;
      }
      case "create": {
        const el = this.elements.find((x) => x.id === p.id);
        if (!el) break;
        let ex = wx;
        let ey = wy;
        // Shift = lock to a square (1:1) growing from the start corner.
        if (e.shiftKey) {
          const s = Math.max(
            Math.abs(wx - p.origin[0]),
            Math.abs(wy - p.origin[1]),
          );
          ex = p.origin[0] + Math.sign(wx - p.origin[0] || 1) * s;
          ey = p.origin[1] + Math.sign(wy - p.origin[1] || 1) * s;
        }
        el.x = Math.min(p.origin[0], ex);
        el.y = Math.min(p.origin[1], ey);
        el.width = Math.abs(ex - p.origin[0]);
        el.height = Math.abs(ey - p.origin[1]);
        this.dragDirty = true;
        this.scheduleRender();
        break;
      }
      case "freedraw": {
        const el = this.elements.find((x) => x.id === p.id);
        if (!el?.points) break;
        el.points.push([wx - el.x, wy - el.y]);
        this.dragDirty = true;
        this.scheduleRender();
        break;
      }
      case "arrowdraw": {
        const el = this.elements.find((x) => x.id === p.id);
        if (!el?.points) break;
        let ex = wx;
        let ey = wy;
        // Shift = snap the segment angle to the nearest 45°.
        if (e.shiftKey) {
          const ddx = wx - p.origin[0];
          const ddy = wy - p.origin[1];
          const len = Math.hypot(ddx, ddy);
          const ang =
            Math.round(Math.atan2(ddy, ddx) / (Math.PI / 4)) * (Math.PI / 4);
          ex = p.origin[0] + Math.cos(ang) * len;
          ey = p.origin[1] + Math.sin(ang) * len;
        }
        el.points[1] = [ex, ey];
        syncArrowBox(el);
        this.dragDirty = true;
        this.scheduleRender();
        break;
      }
      case "resize": {
        this.applyResize(p, wx, wy, e.shiftKey);
        this.dragDirty = true;
        this.scheduleRender();
        break;
      }
      case "scale": {
        this.applyScale(p, wx, wy, e.shiftKey);
        this.dragDirty = true;
        this.scheduleRender();
        break;
      }
      case "erase": {
        this.eraseAt(wx, wy);
        break;
      }
    }
  };

  private onPointerUp = (): void => {
    const p = this.pointer;
    this.pointer = { kind: "idle" };
    // Drag is over: drop any snap guides that were drawn during the move.
    if (this.guides.length) {
      this.guides = [];
      this.scheduleRender();
    }

    if (p.kind === "pan") {
      this.updateCursor();
      return;
    }
    if (p.kind === "marquee") {
      this.finishMarquee(p.additive);
      this.marquee = null;
      this.scheduleRender();
      return;
    }
    if (p.kind === "create") {
      this.finishCreate(p.id);
      return;
    }
    if (p.kind === "arrowdraw") {
      this.finishArrow(p);
      return;
    }
    if (
      p.kind === "move" ||
      p.kind === "resize" ||
      p.kind === "scale" ||
      p.kind === "erase" ||
      p.kind === "freedraw"
    ) {
      if (p.kind === "freedraw") {
        const el = this.elements.find((x) => x.id === p.id);
        if (el) this.finishFreedrawNormalize(el);
      }
      if (this.dragDirty && this.dragBefore) {
        this.history.push(this.dragBefore);
        this.emitChange();
      } else if (p.kind === "freedraw") {
        // A bare click with the pen leaves a zero-length stroke — drop it.
        this.elements = this.elements.filter((x) => x.id !== p.id);
      }
      this.dragBefore = null;
      this.dragDirty = false;
    }
  };

  private finishMarquee(additive: boolean): void {
    if (!this.marquee) return;
    const m = this.marquee;
    if (m.width < 2 && m.height < 2) return;
    const hits = this.elements.filter(
      (el) => !el.locked && boxesIntersect(elementBox(el), m),
    );
    const ids = additive ? new Set(this.selected) : new Set<string>();
    for (const el of hits) ids.add(el.id);
    this.setSelection(selOps.withGroup(this.elements, [...ids]));
  }

  // --- create / resize -----------------------------------------------------

  private startCreate(wx: number, wy: number): void {
    const id = `brd-${crypto.randomUUID()}`;
    const type = this.tool === "sticky" ? "sticky" : this.tool;
    this.dragBefore = cloneElements(this.elements);
    this.dragDirty = false;
    if (this.tool === "freedraw") {
      const el: SceneElement = {
        id,
        type: "freedraw",
        x: wx,
        y: wy,
        width: 0,
        height: 0,
        points: [[0, 0]],
        schemaVersion: SCENE_SCHEMA_VERSION,
      };
      this.elements.push(el);
      this.pointer = { kind: "freedraw", id };
    } else {
      const el: SceneElement = {
        id,
        type: type as SceneElement["type"],
        x: wx,
        y: wy,
        width: 0,
        height: 0,
        schemaVersion: SCENE_SCHEMA_VERSION,
      };
      this.elements.push(el);
      this.pointer = { kind: "create", id, origin: [wx, wy] };
    }
  }

  private finishCreate(id: string): void {
    const el = this.elements.find((x) => x.id === id);
    if (!el) return;
    // A click (no real drag) → drop a default-sized shape centered on the click.
    if (Math.abs(el.width) < CLICK_SLOP && Math.abs(el.height) < CLICK_SLOP) {
      el.width = DEFAULT_W;
      el.height = DEFAULT_H;
      el.x -= DEFAULT_W / 2;
      el.y -= DEFAULT_H / 2;
    }
    if (this.dragBefore) this.history.push(this.dragBefore);
    this.dragBefore = null;
    this.setSelection([id]);
    this.setTool("select");
    this.emitChange();
  }

  private finishFreedrawNormalize(el: SceneElement): void {
    // Recenter freedraw bbox so x/y is the points' min corner.
    const pts = el.points ?? [];
    if (pts.length === 0) return;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [px, py] of pts) {
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    el.x += minX;
    el.y += minY;
    el.width = maxX - minX;
    el.height = maxY - minY;
    el.points = pts.map(
      ([px, py]) => [px - minX, py - minY] as [number, number],
    );
    smoothFreedraw(el);
  }

  /** Resize the single selected element from a handle drag. With `lockAspect` (Shift), the
   * original aspect ratio is preserved: corner handles anchor the opposite corner; edge
   * handles scale the cross axis symmetrically about the box center. */
  private applyResize(
    p: Extract<Pointer, { kind: "resize" }>,
    wx: number,
    wy: number,
    lockAspect: boolean,
  ): void {
    const el = this.elements.find((x) => x.id === p.id);
    if (!el) return;
    const b = p.box;
    const h = p.handle;
    let left = b.x;
    let top = b.y;
    let right = b.x + b.width;
    let bottom = b.y + b.height;

    if (lockAspect && b.width > 0 && b.height > 0) {
      const aspect = b.width / b.height;
      const horiz = h.includes("w") || h.includes("e");
      const vert = h.includes("n") || h.includes("s");
      // The edge NOT being dragged stays fixed (the anchor).
      const ax = h.includes("w") ? b.x + b.width : b.x;
      const ay = h.includes("n") ? b.y + b.height : b.y;
      if (horiz && vert) {
        let dw = wx - ax;
        let dh = wy - ay;
        // Follow whichever axis the cursor pushed further (relative to the start size).
        if (Math.abs(dw) / b.width >= Math.abs(dh) / b.height) {
          dh =
            ((dh !== 0 ? Math.sign(dh) : h.includes("n") ? -1 : 1) *
              Math.abs(dw)) /
            aspect;
        } else {
          dw =
            (dw !== 0 ? Math.sign(dw) : h.includes("w") ? -1 : 1) *
            Math.abs(dh) *
            aspect;
        }
        left = Math.min(ax, ax + dw);
        right = Math.max(ax, ax + dw);
        top = Math.min(ay, ay + dh);
        bottom = Math.max(ay, ay + dh);
      } else if (horiz) {
        const dw = wx - ax;
        const newH = Math.abs(dw) / aspect;
        const cy = b.y + b.height / 2;
        left = Math.min(ax, ax + dw);
        right = Math.max(ax, ax + dw);
        top = cy - newH / 2;
        bottom = cy + newH / 2;
      } else {
        const dh = wy - ay;
        const newW = Math.abs(dh) * aspect;
        const cx = b.x + b.width / 2;
        top = Math.min(ay, ay + dh);
        bottom = Math.max(ay, ay + dh);
        left = cx - newW / 2;
        right = cx + newW / 2;
      }
    } else {
      if (h.includes("w")) left = wx;
      if (h.includes("e")) right = wx;
      if (h.includes("n")) top = wy;
      if (h.includes("s")) bottom = wy;
    }

    const minSize = 8;
    el.x = Math.min(left, right);
    el.y = Math.min(top, bottom);
    el.width = Math.max(minSize, Math.abs(right - left));
    el.height = Math.max(minSize, Math.abs(bottom - top));
  }

  // --- arrow / line tools --------------------------------------------------

  private startLinear(type: "arrow" | "line", wx: number, wy: number): void {
    const id = `brd-${crypto.randomUUID()}`;
    this.dragBefore = cloneElements(this.elements);
    this.dragDirty = false;
    const el: SceneElement = {
      id,
      type,
      x: wx,
      y: wy,
      width: 0,
      height: 0,
      points: [
        [wx, wy],
        [wx, wy],
      ],
      schemaVersion: SCENE_SCHEMA_VERSION,
    };
    this.elements.push(el);
    this.pointer = { kind: "arrowdraw", id, origin: [wx, wy] };
  }

  private finishArrow(p: Extract<Pointer, { kind: "arrowdraw" }>): void {
    const el = this.elements.find((x) => x.id === p.id);
    if (!el?.points) {
      this.dragBefore = null;
      this.dragDirty = false;
      return;
    }
    const [sx, sy] = el.points[0];
    const [ex, ey] = el.points[1];
    // A bare click (no real drag) — drop the zero-length arrow.
    if (Math.hypot(ex - sx, ey - sy) < CLICK_SLOP) {
      this.elements = this.elements.filter((x) => x.id !== el.id);
      this.dragBefore = null;
      this.dragDirty = false;
      this.setTool("select");
      this.scheduleRender();
      return;
    }
    const startEl = this.bindTargetAt(sx, sy, el.id);
    const endEl = this.bindTargetAt(ex, ey, el.id);
    if (startEl) el.start = { id: startEl.id };
    if (endEl) el.end = { id: endEl.id };
    syncArrowBox(el);
    if (this.dragBefore) this.history.push(this.dragBefore);
    this.dragBefore = null;
    this.dragDirty = false;
    this.setSelection([el.id]);
    this.setTool("select");
    this.emitChange();
  }

  /** Top bindable element under a world point that a linear endpoint can attach to
   * (skips other linear elements and freedraw — their geometry is the points). */
  private bindTargetAt(
    wx: number,
    wy: number,
    selfId: string,
  ): SceneElement | null {
    const tol = 6 / this.viewport.zoom;
    const map = this.byId();
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const el = this.elements[i];
      if (el.id === selfId || isLinear(el.type) || el.type === "freedraw")
        continue;
      if (hitTestElement(el, wx, wy, tol, map)) return el;
    }
    return null;
  }

  // --- clipboard / selection ops -------------------------------------------

  selectAll(): void {
    if (this.elements.length === 0) return;
    this.setSelection(this.elements.map((e) => e.id));
    this.scheduleRender();
  }

  copySelection(): void {
    if (this.selected.size === 0) return;
    this.clipboard = cloneElements(
      this.elements.filter((e) => this.selected.has(e.id)),
    );
  }

  cutSelection(): void {
    if (this.selected.size === 0) return;
    this.copySelection();
    this.deleteSelected();
  }

  paste(): void {
    this.addCopies(this.clipboard);
  }

  duplicateSelected(): void {
    if (this.selected.size === 0) return;
    this.addCopies(this.elements.filter((e) => this.selected.has(e.id)));
  }

  /** Append offset deep-copies of `src` (fresh ids, remapped intra-set arrow bindings +
   * group ids), select them, and commit one history step. Shared by paste + duplicate. */
  private addCopies(src: readonly SceneElement[]): void {
    if (src.length === 0) return;
    const copies = selOps.copyWithOffset(src, PASTE_OFFSET);
    const before = this.elements;
    this.elements = [...before, ...copies];
    this.history.push(before);
    this.setSelection(copies.map((e) => e.id));
    this.emitChange();
  }

  nudgeSelected(dx: number, dy: number): void {
    if (this.selected.size === 0) return;
    this.commit(selOps.nudge(this.elements, this.selected, dx, dy));
  }

  bringToFront(): void {
    this.reorderSelection("front");
  }

  sendToBack(): void {
    this.reorderSelection("back");
  }

  private reorderSelection(where: "front" | "back"): void {
    if (this.selected.size === 0) return;
    this.commit(selOps.reorder(this.elements, this.selected, where));
  }

  bringForward(): void {
    if (this.selected.size === 0) return;
    this.commit(selOps.reorderStep(this.elements, this.selected, "forward"));
  }

  sendBackward(): void {
    if (this.selected.size === 0) return;
    this.commit(selOps.reorderStep(this.elements, this.selected, "backward"));
  }

  /** Line the selection up to a shared edge / midline (needs ≥2). */
  alignSelected(edge: selOps.AlignEdge): void {
    if (this.selected.size < 2) return;
    this.commit(selOps.align(this.elements, this.selected, edge));
  }

  /** Even out spacing between selected elements along an axis (needs ≥3). */
  distributeSelected(axis: selOps.DistributeAxis): void {
    if (this.selected.size < 3) return;
    this.commit(selOps.distribute(this.elements, this.selected, axis));
  }

  /** Apply a style change (color / width / dash) to the selection. `null` clears a key back
   * to the type's theme default; a key absent from `patch` is left untouched. */
  applyStyle(patch: selOps.StylePatch): void {
    if (this.selected.size === 0) return;
    if (
      !("fill" in patch) &&
      !("stroke" in patch) &&
      !("strokeWidth" in patch) &&
      !("strokeStyle" in patch) &&
      !("textAlign" in patch) &&
      !("opacity" in patch)
    ) {
      return;
    }
    this.commit(selOps.applyStyle(this.elements, this.selected, patch));
  }

  /** Style of the first selected element (drives the style panel's active swatch / preset). */
  getSelectedStyle(): {
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    strokeStyle?: SceneElement["strokeStyle"];
    textAlign?: SceneElement["textAlign"];
    opacity?: number;
  } {
    for (const el of this.elements) {
      if (this.selected.has(el.id)) {
        return {
          fill: el.fill,
          stroke: el.stroke,
          strokeWidth: el.strokeWidth,
          strokeStyle: el.strokeStyle,
          textAlign: el.textAlign,
          opacity: el.opacity,
        };
      }
    }
    return {};
  }

  lockSelected(): void {
    if (this.selected.size === 0) return;
    this.commit(selOps.setLocked(this.elements, this.selected, true));
  }

  unlockSelected(): void {
    if (this.selected.size === 0) return;
    this.commit(selOps.setLocked(this.elements, this.selected, false));
  }

  unlockAllOnBoard(): void {
    if (!this.elements.some((e) => e.locked)) return;
    this.commit(selOps.unlockAll(this.elements));
  }

  layoutSelectedGrid(): void {
    if (this.selected.size < 2) return;
    this.commit(layoutGrid(this.elements, this.selected));
  }

  groupSelected(): void {
    if (this.selected.size < 2) return;
    this.commit(
      selOps.setGroup(
        this.elements,
        this.selected,
        `grp-${crypto.randomUUID()}`,
      ),
    );
  }

  ungroupSelected(): void {
    if (this.selected.size === 0) return;
    const hasGroup = this.elements.some(
      (e) => this.selected.has(e.id) && e.groupIds?.length,
    );
    if (!hasGroup) return;
    this.commit(selOps.clearGroup(this.elements, this.selected));
  }

  // --- image import (paste / drop / 工具栏选图, §九 截图走视觉) ---------------

  /** Insert image files chosen via the toolbar's「插入图片」picker. Non-image files are
   * skipped; multiples cascade by {@link PASTE_OFFSET} so they don't perfectly overlap. */
  insertImageFiles(files: Iterable<File>): void {
    const [cx, cy] = screenToWorld(this.viewport, this.cssW / 2, this.cssH / 2);
    let i = 0;
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      void this.importImageFile(file, [
        cx + i * PASTE_OFFSET,
        cy + i * PASTE_OFFSET,
      ]);
      i++;
    }
  }

  private onPaste = (e: ClipboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
    ) {
      return; // let an editable target handle its own paste
    }
    const items = e.clipboardData?.items;
    const imageItem = items
      ? [...items].find((it) => it.type.startsWith("image/"))
      : undefined;
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        e.preventDefault();
        void this.importImageFile(file);
        return;
      }
    }
    // No image on the system clipboard → fall back to the internal element clipboard.
    if (this.clipboard.length) {
      e.preventDefault();
      this.paste();
    }
  };

  private onDragOver = (e: DragEvent): void => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault(); // allow drop + stop Electron navigating to the dropped file
      e.dataTransfer.dropEffect = "copy";
    }
  };

  private onDrop = (e: DragEvent): void => {
    const file = e.dataTransfer?.files
      ? [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"))
      : undefined;
    if (!file) return;
    e.preventDefault();
    void this.importImageFile(file, this.toWorld(e));
  };

  private async importImageFile(
    file: Blob,
    at?: [number, number],
  ): Promise<void> {
    try {
      const { src, w, h } = await loadImageForImport(file);
      this.addImage(src, w, h, at);
    } catch (err) {
      console.error("[whiteboard] 图片导入失败", err);
    }
  }

  /** Add an `image` element (from paste / drop), centered on `at` (world) or the viewport
   * center, scaled so its longest side starts at ~{@link IMAGE_PLACE} world units. One
   * history step; selects the new image and drops back to the select tool. */
  private addImage(
    src: string,
    naturalW: number,
    naturalH: number,
    at?: [number, number],
  ): void {
    const [cx, cy] =
      at ?? screenToWorld(this.viewport, this.cssW / 2, this.cssH / 2);
    const scale = Math.min(1, IMAGE_PLACE / Math.max(naturalW, naturalH));
    const w = Math.max(1, Math.round(naturalW * scale));
    const h = Math.max(1, Math.round(naturalH * scale));
    const el: SceneElement = {
      id: `brd-${crypto.randomUUID()}`,
      type: "image",
      x: cx - w / 2,
      y: cy - h / 2,
      width: w,
      height: h,
      src,
      schemaVersion: SCENE_SCHEMA_VERSION,
    };
    const before = this.elements;
    this.elements = [...before, el];
    this.history.push(before);
    this.setSelection([el.id]);
    this.setTool("select");
    this.emitChange();
  }

  // --- wheel / zoom --------------------------------------------------------

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const [sx, sy] = this.toScreen(e);
      this.zoomAt(Math.exp(-e.deltaY * 0.01), sx, sy);
    } else {
      this.viewport.panX -= e.deltaX;
      this.viewport.panY -= e.deltaY;
      this.scheduleRender();
    }
  };

  private zoomAt(factor: number, sx: number, sy: number): void {
    const newZoom = clamp(this.viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const [wx, wy] = screenToWorld(this.viewport, sx, sy);
    this.viewport.zoom = newZoom;
    this.viewport.panX = sx - wx * newZoom;
    this.viewport.panY = sy - wy * newZoom;
    this.cb.onViewportChange(newZoom);
    this.scheduleRender();
  }

  // --- keyboard ------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    const typing =
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);
    if (typing) return;

    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod) {
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (key === "y") {
        e.preventDefault();
        this.redo();
      } else if (key === "a") {
        e.preventDefault();
        this.selectAll();
      } else if (key === "c") {
        this.copySelection();
      } else if (key === "x") {
        e.preventDefault();
        this.cutSelection();
        // Ctrl+V is intentionally NOT handled here: the window `paste` event (onPaste) is the
        // single paste path, so a system-clipboard image and the internal element clipboard
        // can't both fire. We don't preventDefault Ctrl+V, so the native paste event runs.
      } else if (key === "d") {
        e.preventDefault();
        this.duplicateSelected();
      } else if (key === "]") {
        e.preventDefault();
        this.bringToFront();
      } else if (key === "[") {
        e.preventDefault();
        this.sendToBack();
      } else if (key === "g") {
        e.preventDefault();
        if (e.shiftKey) this.ungroupSelected();
        else this.groupSelected();
      } else if (key === "2") {
        e.preventDefault();
        this.zoomToSelection();
      }
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.selected.size) {
        e.preventDefault();
        this.deleteSelected();
      }
      return;
    }
    if (e.key.startsWith("Arrow") && this.selected.size) {
      e.preventDefault();
      const step = e.shiftKey ? NUDGE_LARGE : NUDGE;
      if (e.key === "ArrowLeft") this.nudgeSelected(-step, 0);
      else if (e.key === "ArrowRight") this.nudgeSelected(step, 0);
      else if (e.key === "ArrowUp") this.nudgeSelected(0, -step);
      else if (e.key === "ArrowDown") this.nudgeSelected(0, step);
      return;
    }
    if (e.key === " ") {
      this.spaceDown = true;
      this.updateCursor();
      return;
    }
    if (e.key === "Escape" && this.selected.size) {
      this.setSelection([]);
      this.scheduleRender();
      return;
    }
    const toolKey = TOOL_KEYS[key];
    if (toolKey) this.setTool(toolKey);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === " ") {
      this.spaceDown = false;
      this.updateCursor();
    }
  };

  // --- text editing --------------------------------------------------------

  private onDoubleClick = (e: MouseEvent): void => {
    const [wx, wy] = this.toWorld(e);
    const hit = this.topElementAt(wx, wy);
    if (hit && hit.type !== "arrow" && hit.type !== "freedraw") {
      this.textEditor.begin(hit, [wx, wy]);
    } else if (!hit) {
      this.textEditor.begin(null, [wx, wy]);
    }
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const [wx, wy] = this.toWorld(e);
    const hit = this.topElementAt(wx, wy);
    // Right-clicking an unselected element selects it (its whole group) first, so the menu
    // acts on what's under the cursor; right-clicking empty space keeps the selection.
    if (hit && !this.selected.has(hit.id)) {
      this.setSelection(selOps.withGroup(this.elements, [hit.id]));
    }
    const [sx, sy] = this.toScreen(e);
    this.cb.onContextMenu(sx, sy);
  };

  /** Apply a committed text edit from {@link TextEditor}: update an existing element (empty
   * text deletes a pure text node), or create a new text element. The engine owns the scene
   * + history, so the overlay stays a dumb DOM concern. */
  private commitText(c: TextCommit): void {
    const before = cloneElements(this.elements);
    let changed = false;

    if (c.id) {
      const el = this.elements.find((x) => x.id === c.id);
      if (el) {
        if (el.type === "text" && !c.text) {
          this.elements = this.elements.filter((x) => x.id !== el.id);
          this.selected.delete(el.id);
          this.cb.onSelectionChange([...this.selected]);
          changed = true;
        } else if ((el.text ?? "") !== c.text) {
          el.text = c.text;
          if (el.type === "text") this.measureText(el);
          changed = true;
        }
      }
    } else if (c.text) {
      const el: SceneElement = {
        id: `brd-${crypto.randomUUID()}`,
        type: "text",
        x: c.world[0],
        y: c.world[1],
        width: 40,
        height: 24,
        text: c.text,
        fontSize: 18,
        schemaVersion: SCENE_SCHEMA_VERSION,
      };
      this.measureText(el);
      this.elements.push(el);
      changed = true;
    }

    if (changed) {
      this.history.push(before);
      this.emitChange();
    } else {
      this.scheduleRender();
    }
  }

  private measureText(el: SceneElement): void {
    const size = el.fontSize ?? 18;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
    const lines = (el.text ?? "").split("\n");
    let max = 40;
    for (const line of lines)
      max = Math.max(max, this.ctx.measureText(line).width);
    this.ctx.restore();
    el.width = max + 8;
    el.height = lines.length * size * 1.3 + 4;
  }

  private computeMoveSnap(
    dx: number,
    dy: number,
  ): {
    dx: number;
    dy: number;
    guides: Array<[number, number, number, number]>;
  } {
    return snapMove(this.elements, this.selected, dx, dy);
  }

  /** Eraser tool: delete unlocked elements under the pointer (whole element, not partial trim). */
  private eraseAt(wx: number, wy: number): void {
    const tol = 10 / this.viewport.zoom;
    const map = this.byId();
    const toRemove = new Set<string>();
    for (const el of this.elements) {
      if (el.locked) continue;
      if (hitTestElement(el, wx, wy, tol, map)) toRemove.add(el.id);
    }
    if (toRemove.size === 0) return;
    this.elements = this.elements.filter(
      (e) =>
        !toRemove.has(e.id) &&
        !(
          e.type === "arrow" &&
          ((e.start?.id && toRemove.has(e.start.id)) ||
            (e.end?.id && toRemove.has(e.end.id)))
        ),
    );
    for (const id of toRemove) this.selected.delete(id);
    this.dragDirty = true;
    this.scheduleRender();
  }

  /** Scale every selected element proportionally when dragging a multi-selection handle. */
  private applyScale(
    p: Extract<Pointer, { kind: "scale" }>,
    wx: number,
    wy: number,
    lockAspect: boolean,
  ): void {
    const b = p.box;
    const h = p.handle;
    let left = b.x;
    let top = b.y;
    let right = b.x + b.width;
    let bottom = b.y + b.height;

    if (h.includes("w")) left = wx;
    if (h.includes("e")) right = wx;
    if (h.includes("n")) top = wy;
    if (h.includes("s")) bottom = wy;

    let newW = Math.max(8, Math.abs(right - left));
    let newH = Math.max(8, Math.abs(bottom - top));

    if (lockAspect && b.width > 0 && b.height > 0) {
      const aspect = b.width / b.height;
      if (newW / newH > aspect) newW = newH * aspect;
      else newH = newW / aspect;
      if (h.includes("w")) left = right - newW;
      else right = left + newW;
      if (h.includes("n")) top = bottom - newH;
      else bottom = top + newH;
    }

    const anchorX = h.includes("w") ? b.x + b.width : b.x;
    const anchorY = h.includes("n") ? b.y + b.height : b.y;
    const scaleX = newW / b.width;
    const scaleY = newH / b.height;

    const idSet = this.selected;
    this.elements = p.base.map((el) => {
      if (!idSet.has(el.id) || el.locked) return el;
      const copy = cloneElements([el])[0];
      const eb = elementBox(el);
      copy.x = anchorX + (eb.x - anchorX) * scaleX;
      copy.y = anchorY + (eb.y - anchorY) * scaleY;
      copy.width = eb.width * scaleX;
      copy.height = eb.height * scaleY;
      if (isLinear(copy.type) && copy.points) {
        copy.points = copy.points.map(
          ([px, py]) =>
            [
              anchorX + (px - anchorX) * scaleX,
              anchorY + (py - anchorY) * scaleY,
            ] as [number, number],
        );
      }
      return copy;
    });
  }
}
