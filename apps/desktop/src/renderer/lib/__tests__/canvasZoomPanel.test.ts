import {
  DEBATE_HUD_TAB_ID,
  WORKSPACE_TAB_ID,
  useSidePanelStore,
} from "@/stores/sidePanel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCanvasZoomPanelPref,
  captureCanvasZoomPanelPref,
  defaultCanvasZoomPanelPref,
  loadCanvasZoomPanelPref,
  persistCanvasZoomPanelPref,
} from "../canvasZoomPanel";

describe("canvas zoom panel persistence", () => {
  const KEY = "agentcore:canvas-zoom-panel";
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        store = {};
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() {
        return Object.keys(store).length;
      },
    } as Storage;
    useSidePanelStore.setState({
      open: false,
      tabs: [],
      activeTabId: WORKSPACE_TAB_ID,
      pendingFilePreview: null,
    });
  });

  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
  });

  it("round-trips a closed preference", () => {
    persistCanvasZoomPanelPref("c1", { kind: "closed" });
    expect(loadCanvasZoomPanelPref("c1")).toEqual({ kind: "closed" });
  });

  it("round-trips run and content detail surfaces", () => {
    persistCanvasZoomPanelPref("c1", {
      kind: "run",
      messageId: "m1",
      runId: "r1",
      title: "研究员",
    });
    persistCanvasZoomPanelPref("c2", {
      kind: "content",
      messageId: "m2",
      contentMessageId: "a1",
      title: "最终回答",
      endpoint: "answer",
    });
    expect(loadCanvasZoomPanelPref("c1")).toMatchObject({ kind: "run" });
    expect(loadCanvasZoomPanelPref("c2")).toMatchObject({
      kind: "content",
      endpoint: "answer",
    });
  });

  it("drops unknown stored shapes", () => {
    store[KEY] = JSON.stringify({
      c1: { kind: "nope" },
      c2: { kind: "closed" },
    });
    expect(loadCanvasZoomPanelPref("c1")).toBeNull();
    expect(loadCanvasZoomPanelPref("c2")).toEqual({ kind: "closed" });
  });
});

describe("captureCanvasZoomPanelPref", () => {
  beforeEach(() => {
    useSidePanelStore.setState({
      open: true,
      tabs: [],
      activeTabId: WORKSPACE_TAB_ID,
      pendingFilePreview: null,
    });
  });

  it("captures workspace and closed states", () => {
    expect(captureCanvasZoomPanelPref()).toEqual({ kind: "workspace" });
    useSidePanelStore.getState().closePanel();
    expect(captureCanvasZoomPanelPref()).toEqual({ kind: "closed" });
  });

  it("captures an active run tab", () => {
    useSidePanelStore.getState().showRunDetail("m1", "r1", "写手");
    expect(captureCanvasZoomPanelPref()).toEqual({
      kind: "run",
      messageId: "m1",
      runId: "r1",
      title: "写手",
    });
  });
});

describe("applyCanvasZoomPanelPref", () => {
  beforeEach(() => {
    useSidePanelStore.setState({
      open: false,
      tabs: [],
      activeTabId: WORKSPACE_TAB_ID,
      pendingFilePreview: null,
    });
  });

  it("restores closed and debate-hud surfaces", () => {
    useSidePanelStore.setState({ open: true, activeTabId: WORKSPACE_TAB_ID });
    applyCanvasZoomPanelPref({ kind: "closed" });
    expect(useSidePanelStore.getState().open).toBe(false);

    applyCanvasZoomPanelPref({ kind: "debate-hud" });
    expect(useSidePanelStore.getState().activeTabId).toBe(DEBATE_HUD_TAB_ID);
  });

  it("recreates a content tab on restore", () => {
    applyCanvasZoomPanelPref({
      kind: "content",
      messageId: "m1",
      contentMessageId: "a1",
      title: "最终回答",
      endpoint: "answer",
    });
    const s = useSidePanelStore.getState();
    expect(s.open).toBe(true);
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]?.kind).toBe("content");
  });
});

describe("defaultCanvasZoomPanelPref", () => {
  it("prefers debate hud or final answer over workspace", () => {
    expect(
      defaultCanvasZoomPanelPref({
        showRoom: true,
        scopeId: "m1",
        finalAnswerId: "a1",
      }),
    ).toEqual({ kind: "debate-hud" });
    expect(
      defaultCanvasZoomPanelPref({
        showRoom: false,
        scopeId: "m1",
        finalAnswerId: "a1",
      }),
    ).toMatchObject({ kind: "content", contentMessageId: "a1" });
    expect(
      defaultCanvasZoomPanelPref({
        showRoom: false,
        scopeId: "m1",
        finalAnswerId: null,
      }),
    ).toEqual({ kind: "closed" });
  });
});
