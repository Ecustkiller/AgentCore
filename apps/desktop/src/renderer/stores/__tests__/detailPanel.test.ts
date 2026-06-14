import { beforeEach, describe, expect, it } from "vitest";
import {
  DETAIL_PANEL_MAX_TABS,
  DETAIL_PANEL_MAX_WIDTH,
  DETAIL_PANEL_MIN_WIDTH,
  type DetailTab,
  runDetailTabId,
  useDetailPanelStore,
} from "../detailPanel";
import { type ExecutionPlan, useExecutionStore } from "../execution";

const panel = () => useDetailPanelStore.getState();
const exec = () => useExecutionStore.getState();

const plan: ExecutionPlan = {
  id: "exec-1",
  planType: "multi_agent",
  taskSummary: "分析对比 React 和 Vue",
  agents: [{ id: "agent-1", role: "研究员", modelPreference: "strong" }],
  runs: [{ id: "run-1", agentId: "agent-1", task: "研究", dependsOn: [] }],
};

const runDetail = (runId: string): DetailTab => ({
  id: runDetailTabId(runId),
  kind: "run-detail",
  title: runId,
  runId,
});

beforeEach(() => {
  // The store hydrates from localStorage at import; pin a known baseline so each
  // test starts from a closed, default-width, tab-less, un-overridden panel.
  useDetailPanelStore.setState({
    open: false,
    width: 400,
    tabs: [],
    activeTabId: null,
    manualOverride: false,
    boundExecutionId: null,
  });
  exec().clearExecution();
});

describe("setWidth", () => {
  it("clamps below the minimum", () => {
    panel().setWidth(100);
    expect(panel().width).toBe(DETAIL_PANEL_MIN_WIDTH);
  });

  it("clamps above the maximum", () => {
    panel().setWidth(9999);
    expect(panel().width).toBe(DETAIL_PANEL_MAX_WIDTH);
  });

  it("rounds and keeps an in-range value", () => {
    panel().setWidth(421.6);
    expect(panel().width).toBe(422);
  });
});

describe("openTab", () => {
  it("opens the panel, appends and activates the tab, records the override", () => {
    panel().openProgress();
    expect(panel().open).toBe(true);
    expect(panel().tabs.map((t) => t.id)).toEqual(["task-progress"]);
    expect(panel().activeTabId).toBe("task-progress");
    expect(panel().manualOverride).toBe(true);
  });

  it("dedups by id and updates the title in place", () => {
    panel().openTab(runDetail("run-1"));
    panel().openTab({ ...runDetail("run-1"), title: "研究员" });
    expect(panel().tabs).toHaveLength(1);
    expect(panel().tabs[0].title).toBe("研究员");
  });

  it("activate:false keeps the current active tab", () => {
    panel().openProgress();
    panel().openTab(runDetail("run-1"), { activate: false });
    expect(panel().tabs).toHaveLength(2);
    expect(panel().activeTabId).toBe("task-progress");
  });

  it("caps the strip at the maximum, dropping the oldest", () => {
    for (let i = 0; i < DETAIL_PANEL_MAX_TABS + 2; i++) {
      panel().openTab(runDetail(`run-${i}`));
    }
    expect(panel().tabs).toHaveLength(DETAIL_PANEL_MAX_TABS);
    // run-0 and run-1 were pushed out; run-2 is now the oldest.
    expect(panel().tabs[0].id).toBe(runDetailTabId("run-2"));
  });
});

describe("closeTab", () => {
  it("removes the tab and falls back to the last remaining one", () => {
    panel().openProgress();
    panel().openTab(runDetail("run-1"));
    panel().setActiveTab("task-progress");
    panel().closeTab("task-progress");
    expect(panel().tabs.map((t) => t.id)).toEqual([runDetailTabId("run-1")]);
    expect(panel().activeTabId).toBe(runDetailTabId("run-1"));
  });

  it("hides the panel when the last tab is closed", () => {
    panel().openProgress();
    panel().closeTab("task-progress");
    expect(panel().tabs).toHaveLength(0);
    expect(panel().open).toBe(false);
    expect(panel().activeTabId).toBeNull();
    expect(panel().manualOverride).toBe(true);
  });
});

describe("togglePanel", () => {
  it("opens with a progress tab when empty, then closes", () => {
    panel().togglePanel();
    expect(panel().open).toBe(true);
    expect(panel().tabs.map((t) => t.id)).toEqual(["task-progress"]);
    panel().togglePanel();
    expect(panel().open).toBe(false);
  });
});

describe("autoOpenForPlan", () => {
  it("ignores single-agent turns", () => {
    panel().autoOpenForPlan("single_agent", "exec-1");
    expect(panel().open).toBe(false);
    expect(panel().tabs).toHaveLength(0);
  });

  it("opens, seeds the progress tab and binds the execution", () => {
    panel().autoOpenForPlan("multi_agent", "exec-1");
    expect(panel().open).toBe(true);
    expect(panel().tabs.map((t) => t.id)).toEqual(["task-progress"]);
    expect(panel().activeTabId).toBe("task-progress");
    expect(panel().boundExecutionId).toBe("exec-1");
  });

  it("does not flip the manual override (auto, not a user choice)", () => {
    panel().autoOpenForPlan("multi_agent", "exec-1");
    expect(panel().manualOverride).toBe(false);
  });

  it("respects a manual close for the rest of the session", () => {
    panel().closePanel(); // user closed it → manualOverride
    panel().autoOpenForPlan("multi_agent", "exec-1");
    expect(panel().open).toBe(false);
  });

  it("keeps existing tabs for an in-turn delegate batch (same id)", () => {
    panel().autoOpenForPlan("multi_agent", "exec-1");
    panel().openTab(runDetail("run-1"));
    panel().autoOpenForPlan("multi_agent", "exec-1");
    expect(panel().tabs.map((t) => t.id)).toEqual([
      "task-progress",
      runDetailTabId("run-1"),
    ]);
  });

  it("resets tabs to the overview when a new execution starts", () => {
    panel().autoOpenForPlan("multi_agent", "exec-1");
    panel().openTab(runDetail("run-1"));
    panel().autoOpenForPlan("multi_agent", "exec-2");
    expect(panel().tabs.map((t) => t.id)).toEqual(["task-progress"]);
    expect(panel().boundExecutionId).toBe("exec-2");
  });
});

describe("showRunDetail", () => {
  it("opens a run-detail tab and pins the run in the execution store", () => {
    exec().startExecution(plan);
    panel().showRunDetail("run-1", "研究员");
    expect(panel().open).toBe(true);
    expect(panel().activeTabId).toBe(runDetailTabId("run-1"));
    expect(panel().tabs[0].title).toBe("研究员");
    // Focus lives in the execution store (shared with the graph + task card).
    expect(exec().focusedRunId).toBe("run-1");
    expect(exec().focusedAgentId).toBe("agent-1");
  });
});
