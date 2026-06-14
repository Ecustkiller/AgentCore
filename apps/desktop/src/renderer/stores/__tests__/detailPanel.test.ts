import { beforeEach, describe, expect, it } from "vitest";
import {
  DETAIL_PANEL_MAX_TABS,
  DETAIL_PANEL_MAX_WIDTH,
  DETAIL_PANEL_MIN_WIDTH,
  type DetailTab,
  runDetailTabId,
  useDetailPanelStore,
} from "../detailPanel";
import {
  type ExecutionPlan,
  execRuntime,
  useExecutionStore,
} from "../execution";

const panel = () => useDetailPanelStore.getState();
const exec = () => useExecutionStore.getState();
// Each turn's execution + focus lives in its own message slot (§9.3); this suite
// drives one message.
const MID = "msg-1";
const execRt = () => execRuntime(exec(), MID);
const tabId = (runId: string) => runDetailTabId(MID, runId);

const plan: ExecutionPlan = {
  id: "exec-1",
  planType: "multi_agent",
  taskSummary: "分析对比 React 和 Vue",
  agents: [{ id: "agent-1", role: "研究员", modelPreference: "strong" }],
  runs: [{ id: "run-1", agentId: "agent-1", task: "研究", dependsOn: [] }],
};

const runDetail = (runId: string): DetailTab => ({
  id: runDetailTabId(MID, runId),
  title: runId,
  messageId: MID,
  runId,
});

beforeEach(() => {
  // The store hydrates from localStorage at import; pin a known baseline so each
  // test starts from a closed, default-width, tab-less panel.
  useDetailPanelStore.setState({
    open: false,
    width: 400,
    tabs: [],
    activeTabId: null,
  });
  useExecutionStore.setState({ byId: {} });
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
  it("opens the panel, appends and activates the tab", () => {
    panel().openTab(runDetail("run-1"));
    expect(panel().open).toBe(true);
    expect(panel().tabs.map((t) => t.id)).toEqual([tabId("run-1")]);
    expect(panel().activeTabId).toBe(tabId("run-1"));
  });

  it("dedups by id and updates the title in place", () => {
    panel().openTab(runDetail("run-1"));
    panel().openTab({ ...runDetail("run-1"), title: "研究员" });
    expect(panel().tabs).toHaveLength(1);
    expect(panel().tabs[0].title).toBe("研究员");
  });

  it("activate:false keeps the current active tab", () => {
    panel().openTab(runDetail("run-1"));
    panel().openTab(runDetail("run-2"), { activate: false });
    expect(panel().tabs).toHaveLength(2);
    expect(panel().activeTabId).toBe(tabId("run-1"));
  });

  it("caps the strip at the maximum, dropping the oldest", () => {
    for (let i = 0; i < DETAIL_PANEL_MAX_TABS + 2; i++) {
      panel().openTab(runDetail(`run-${i}`));
    }
    expect(panel().tabs).toHaveLength(DETAIL_PANEL_MAX_TABS);
    // run-0 and run-1 were pushed out; run-2 is now the oldest.
    expect(panel().tabs[0].id).toBe(tabId("run-2"));
  });
});

describe("closeTab", () => {
  it("removes the tab and falls back to the last remaining one", () => {
    panel().openTab(runDetail("run-1"));
    panel().openTab(runDetail("run-2"));
    panel().setActiveTab(tabId("run-1"));
    panel().closeTab(tabId("run-1"));
    expect(panel().tabs.map((t) => t.id)).toEqual([tabId("run-2")]);
    expect(panel().activeTabId).toBe(tabId("run-2"));
  });

  it("hides the panel when the last tab is closed", () => {
    panel().openTab(runDetail("run-1"));
    panel().closeTab(tabId("run-1"));
    expect(panel().tabs).toHaveLength(0);
    expect(panel().open).toBe(false);
    expect(panel().activeTabId).toBeNull();
  });
});

describe("togglePanel", () => {
  it("opens, then closes", () => {
    panel().togglePanel();
    expect(panel().open).toBe(true);
    panel().togglePanel();
    expect(panel().open).toBe(false);
  });
});

describe("showRunDetail", () => {
  it("opens a run-detail tab and pins the run in the execution store", () => {
    exec().startExecution(plan, MID);
    panel().showRunDetail(MID, "run-1", "研究员");
    expect(panel().open).toBe(true);
    expect(panel().activeTabId).toBe(tabId("run-1"));
    expect(panel().tabs[0].title).toBe("研究员");
    // Selection lives in the execution store (shared with the inline graph).
    expect(execRt().selectedRunId).toBe("run-1");
  });
});
