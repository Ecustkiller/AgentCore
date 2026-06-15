import { beforeEach, describe, expect, it } from "vitest";
import { type ExecutionPlan, useExecutionStore } from "../execution";
import {
  type DetailTab,
  SIDE_PANEL_MAX_TABS,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  WORKSPACE_TAB_ID,
  runDetailTabId,
  useSidePanelStore,
} from "../sidePanel";

const panel = () => useSidePanelStore.getState();
const exec = () => useExecutionStore.getState();
// Each turn's execution + focus lives in its own message slot (§9.3); this suite
// drives one message.
const MID = "msg-1";
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
  // test starts from a closed, default-width panel sitting on the 工作区 home tab.
  useSidePanelStore.setState({
    open: false,
    width: 400,
    section: "files",
    tabs: [],
    activeTabId: WORKSPACE_TAB_ID,
  });
  useExecutionStore.setState({ byId: {} });
});

describe("setWidth", () => {
  it("clamps below the minimum", () => {
    panel().setWidth(100);
    expect(panel().width).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("clamps above the maximum", () => {
    panel().setWidth(9999);
    expect(panel().width).toBe(SIDE_PANEL_MAX_WIDTH);
  });

  it("rounds and keeps an in-range value", () => {
    panel().setWidth(421.6);
    expect(panel().width).toBe(422);
  });
});

describe("openTab", () => {
  it("opens the panel, appends and activates the run tab", () => {
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
    for (let i = 0; i < SIDE_PANEL_MAX_TABS + 2; i++) {
      panel().openTab(runDetail(`run-${i}`));
    }
    expect(panel().tabs).toHaveLength(SIDE_PANEL_MAX_TABS);
    // run-0 and run-1 were pushed out; run-2 is now the oldest.
    expect(panel().tabs[0].id).toBe(tabId("run-2"));
  });
});

describe("closeTab", () => {
  it("falls back to the neighbour run tab (next, else previous)", () => {
    panel().openTab(runDetail("run-1"));
    panel().openTab(runDetail("run-2"));
    panel().openTab(runDetail("run-3"));
    panel().setActiveTab(tabId("run-2"));
    panel().closeTab(tabId("run-2"));
    // Removing the active middle tab lands on its successor (run-3).
    expect(panel().tabs.map((t) => t.id)).toEqual([
      tabId("run-1"),
      tabId("run-3"),
    ]);
    expect(panel().activeTabId).toBe(tabId("run-3"));
  });

  it("falls back to the 工作区 home when the last run tab is closed", () => {
    panel().openTab(runDetail("run-1"));
    panel().closeTab(tabId("run-1"));
    expect(panel().tabs).toHaveLength(0);
    // The home tab is always there, so the panel stays open.
    expect(panel().open).toBe(true);
    expect(panel().activeTabId).toBe(WORKSPACE_TAB_ID);
  });

  it("keeps the active tab when a different tab is closed", () => {
    panel().openTab(runDetail("run-1"));
    panel().openTab(runDetail("run-2"));
    panel().setActiveTab(tabId("run-2"));
    panel().closeTab(tabId("run-1"));
    expect(panel().tabs.map((t) => t.id)).toEqual([tabId("run-2")]);
    expect(panel().activeTabId).toBe(tabId("run-2"));
  });
});

describe("togglePanel", () => {
  it("opens, then closes (keeping the active tab)", () => {
    panel().showRunDetail(MID, "run-1");
    panel().togglePanel();
    expect(panel().open).toBe(false);
    expect(panel().activeTabId).toBe(tabId("run-1"));
    panel().togglePanel();
    expect(panel().open).toBe(true);
    expect(panel().activeTabId).toBe(tabId("run-1"));
  });
});

describe("showWorkspace", () => {
  it("reveals the panel on the 工作区 home tab", () => {
    panel().showWorkspace();
    expect(panel().open).toBe(true);
    expect(panel().activeTabId).toBe(WORKSPACE_TAB_ID);
  });

  it("returns to the home tab from an active run tab without dropping it", () => {
    panel().openTab(runDetail("run-1"));
    panel().showWorkspace();
    expect(panel().activeTabId).toBe(WORKSPACE_TAB_ID);
    // The run tab is preserved in the strip, just no longer active.
    expect(panel().tabs.map((t) => t.id)).toEqual([tabId("run-1")]);
  });
});

describe("showRunDetail", () => {
  it("pins a run, reveals it, and activates its tab", () => {
    exec().startExecution(plan, MID);
    panel().showWorkspace();
    panel().showRunDetail(MID, "run-1", "研究员");
    expect(panel().open).toBe(true);
    expect(panel().activeTabId).toBe(tabId("run-1"));
    expect(panel().tabs[0].title).toBe("研究员");
  });
});

describe("setSection", () => {
  it("updates the active workspace section", () => {
    expect(panel().section).toBe("files");
    panel().setSection("snapshots");
    expect(panel().section).toBe("snapshots");
  });
});
