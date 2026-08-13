// @vitest-environment jsdom
/**
 * Layout pins for 会话复盘, and the contract for the `?turn=` anchor.
 *
 * Three layout regressions live here. (1) The narrow and wide layouts were two separate
 * subtrees, so every bubble, team graph and worker dock was mounted twice — double the
 * effects, and expanding a section in one copy did nothing to the other. (2) The panes
 * were sized with `calc(100vh - 11rem)`, a number that was already wrong the day the
 * shell moved to `h-dvh` with its own scroll container. (3) The dock was a fixed 480px
 * with no way — mouse or keyboard — to give a long worker transcript more room.
 *
 * The anchor is the fourth: which turn was open lived only in component state, so the
 * best link an operator could hand a colleague pointed at a whole conversation, and a
 * reload dropped them back at the top of it.
 */

import { ConversationReplay } from "@/components/ConversationReplay";
import type {
  AdminConversationReplay,
  ReplayMessage,
  ReplayRun,
} from "@/services/adminObservability";
import { fetchConversationReplay } from "@/services/adminObservability";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/adminObservability", () => ({
  fetchConversationReplay: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * Elements the timeline scrolled to. jsdom ships no layout engine and therefore no
 * `scrollIntoView` at all, so "landed on the anchored turn" is invisible unless the
 * method is stood up and asked what it was called on.
 */
const scrolledInto: HTMLElement[] = [];

beforeEach(() => {
  window.localStorage.clear();
  scrolledInto.length = 0;
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function scrollIntoViewStub(this: HTMLElement) {
      scrolledInto.push(this);
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function run(p: Partial<ReplayRun> & { run_id: string }): ReplayRun {
  return {
    agent_id: p.agent_id ?? p.run_id,
    content: null,
    debrief: null,
    depends_on: [],
    error: null,
    kind: "agent",
    output_summary: null,
    parent_run_id: null,
    role: null,
    status: "completed",
    task: "",
    ...p,
  };
}

function msg(
  p: Partial<ReplayMessage> & { id: string; role: string },
): ReplayMessage {
  return {
    content: null,
    cost_total: 0,
    created_at: "2026-08-01T00:00:00Z",
    credential_source: null,
    harvest_kind: null,
    metrics: null,
    models: [],
    origin: null,
    runs: [],
    spans: [],
    trace_id: null,
    ...p,
  };
}

function replay(messages: ReplayMessage[]): AdminConversationReplay {
  return {
    conversation: {
      created_at: "2026-08-01T00:00:00Z",
      display_name: "Alice",
      id: "c1",
      title: "一次多 Agent 会话",
      user_id: "u1",
      username: "alice",
    },
    cost_total: 0,
    errors: 0,
    messages,
    turns: 1,
  };
}

const MESSAGES: ReplayMessage[] = [
  msg({ id: "u1", role: "user", content: "帮我查一下" }),
  msg({
    id: "a1",
    role: "assistant",
    content: "CEO 汇总",
    runs: [run({ run_id: "r1", role: "研究员", task: "搜集资料" })],
  }),
];

/** Reads back what the page did to the address it was opened at. */
function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <span data-testid="loc-search">{location.search}</span>
      <span data-testid="loc-from">
        {(location.state as { from?: string } | null)?.from ?? ""}
      </span>
      <span data-testid="nav-type">{useNavigationType()}</span>
    </>
  );
}

function renderReplay(
  opts: { onBack?: () => void; search?: string; state?: unknown } = {},
) {
  const onBack = opts.onBack ?? vi.fn();
  const view = render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/replay/c1",
          search: opts.search ?? "",
          state: opts.state ?? null,
        },
      ]}
    >
      <ConversationReplay conversationId="c1" onBack={onBack} backLabel="返回" />
      <LocationProbe />
    </MemoryRouter>,
  );
  return { ...view, onBack };
}

/** Opens the worker dock the only way the UI allows: pick a node in the team graph. */
async function openDock() {
  fireEvent.click(await screen.findByText("研究员"));
  return screen.findByRole("separator");
}

describe("ConversationReplay layout", () => {
  it("时间线只挂载一份（宽窄两套布局曾各渲染一遍）", async () => {
    vi.mocked(fetchConversationReplay).mockResolvedValue(replay(MESSAGES));

    renderReplay();

    expect(await screen.findAllByText("CEO 汇总")).toHaveLength(1);
    expect(screen.getAllByText("帮我查一下")).toHaveLength(1);
    expect(screen.getAllByText("协作 · 1 队员")).toHaveLength(1);
  });

  it("正文不再用视口高度硬算（无 100vh 魔法数）", async () => {
    vi.mocked(fetchConversationReplay).mockResolvedValue(replay(MESSAGES));

    const { container } = renderReplay();
    await screen.findByText("CEO 汇总");
    await openDock();

    expect(container.innerHTML).not.toContain("100vh");
  });

  it("开坞后时间线仍在 DOM 中（靠 CSS 隐藏，不丢阅读位置）", async () => {
    vi.mocked(fetchConversationReplay).mockResolvedValue(replay(MESSAGES));

    renderReplay();
    await openDock();

    expect(screen.getAllByText("CEO 汇总")).toHaveLength(1);
    expect(screen.getByText("搜集资料")).toBeTruthy();
  });

  it("队员面板宽度键盘可调并记住", async () => {
    vi.mocked(fetchConversationReplay).mockResolvedValue(replay(MESSAGES));

    renderReplay();
    const handle = await openDock();
    expect(handle.getAttribute("aria-valuenow")).toBe("480");

    // 左箭头把分隔条往左推 = 右侧面板变宽。
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("504");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("456");

    // 越界被夹住，不会拖成负宽或吃掉整屏。
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe("720");
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("320");

    expect(window.localStorage.getItem("admin:replay:dock-width")).toBe("320");
  });

  it("下次进入沿用上次的面板宽度", async () => {
    window.localStorage.setItem("admin:replay:dock-width", "600");
    vi.mocked(fetchConversationReplay).mockResolvedValue(replay(MESSAGES));

    renderReplay();
    const handle = await openDock();

    expect(handle.getAttribute("aria-valuenow")).toBe("600");
  });

  it("加载失败给出重试，成功后照常渲染", async () => {
    vi.mocked(fetchConversationReplay)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(replay(MESSAGES));

    renderReplay();

    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("CEO 汇总")).toBeTruthy());
  });

  it("返回按钮走来源页回调", async () => {
    vi.mocked(fetchConversationReplay).mockResolvedValue(replay(MESSAGES));

    const { onBack } = renderReplay();
    fireEvent.click(await screen.findByRole("button", { name: "返回" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

/** Two assistant turns, so "landed on the anchored one" is a distinguishable claim. */
const ANCHOR_MESSAGES: ReplayMessage[] = [
  msg({ id: "u1", role: "user", content: "帮我查一下" }),
  msg({ id: "a1", role: "assistant", content: "第一回合结论", trace_id: "t-1" }),
  msg({ id: "u2", role: "user", content: "再看看这个" }),
  msg({ id: "a2", role: "assistant", content: "第二回合结论", trace_id: "t-2" }),
];

/** Selection is a ring on screen and `aria-current` in the DOM — pill and bubble both. */
function selectedTurns() {
  return screen.queryAllByRole("button", { current: true });
}

describe("ConversationReplay 回合锚点", () => {
  it("带回合锚点的链接直接打开就落在那个回合上", async () => {
    vi.mocked(fetchConversationReplay).mockResolvedValue(
      replay(ANCHOR_MESSAGES),
    );

    renderReplay({ search: "?turn=a2" });
    await screen.findByText("第二回合结论");

    // 回合索引里的那颗 pill + 时间线里的那条气泡，仅此两处，且都是被锚定的回合。
    const current = selectedTurns();
    expect(current).toHaveLength(2);
    expect(
      current.filter((el) => el.textContent?.includes("第二回合结论")),
    ).toHaveLength(1);
    expect(
      current.filter((el) => el.textContent?.includes("第一回合结论")),
    ).toHaveLength(0);
    // 时间线滚到它，而不是把人留在会话顶部自己找。滚动发生在渲染之后的 effect 里，
    // 所以文本出现不代表滚动已经跑过——同步断言会在负载下抢跑。
    await waitFor(() =>
      expect(scrolledInto.at(-1)?.textContent).toContain("第二回合结论"),
    );
  });

  it("锚点指向不存在的回合时不崩，退回未选中", async () => {
    vi.mocked(fetchConversationReplay).mockResolvedValue(
      replay(ANCHOR_MESSAGES),
    );

    renderReplay({ search: "?turn=早就没有的回合" });

    // 会话照常渲染：既不是白屏，也不是错误态。
    expect(await screen.findByText("第一回合结论")).toBeTruthy();
    expect(screen.getByText("第二回合结论")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    // 也不拿第一个回合顶包充数——解析不出来的锚点就是未选中。
    expect(selectedTurns()).toHaveLength(0);
    expect(scrolledInto).toHaveLength(0);
  });

  it("没有锚点就不预选回合，默认值也不写进地址", async () => {
    vi.mocked(fetchConversationReplay).mockResolvedValue(
      replay(ANCHOR_MESSAGES),
    );

    renderReplay();
    await screen.findByText("第一回合结论");

    expect(selectedTurns()).toHaveLength(0);
    expect(screen.getByTestId("loc-search").textContent).toBe("");
  });

  it("点选回合把锚点写进地址，且是 replace 不堆历史", async () => {
    vi.mocked(fetchConversationReplay).mockResolvedValue(
      replay(ANCHOR_MESSAGES),
    );

    renderReplay();
    fireEvent.click(await screen.findByText("第二回合结论"));

    expect(screen.getByTestId("loc-search").textContent).toBe("?turn=a2");
    expect(selectedTurns()).toHaveLength(2);
    // 每点一个回合压一条历史，浏览器的返回键就再也退不回来源列表了。
    expect(screen.getByTestId("nav-type").textContent).toBe("REPLACE");
  });

  it("写锚点不会把来源页丢掉（返回仍回得去）", async () => {
    vi.mocked(fetchConversationReplay).mockResolvedValue(
      replay(ANCHOR_MESSAGES),
    );

    renderReplay({ state: { from: "/conversations/turns?q=boom" } });
    fireEvent.click(await screen.findByText("第二回合结论"));

    expect(screen.getByTestId("loc-search").textContent).toBe("?turn=a2");
    // setSearchParams 本身是一次导航：不显式把 state 带上，ReplayPage 的来源页就没了。
    expect(screen.getByTestId("loc-from").textContent).toBe(
      "/conversations/turns?q=boom",
    );
  });

  it("trace 链接照旧落在对应回合，改选回合也不冲掉 trace", async () => {
    vi.mocked(fetchConversationReplay).mockResolvedValue(
      replay(ANCHOR_MESSAGES),
    );

    // 对话页的 trace 跳转交过来的是 trace_id，不是消息 id。
    renderReplay({ search: "?trace=t-2" });
    await screen.findByText("第二回合结论");
    expect(
      selectedTurns().filter((el) =>
        el.textContent?.includes("第二回合结论"),
      ),
    ).toHaveLength(1);

    fireEvent.click(screen.getByText("第一回合结论"));
    expect(screen.getByTestId("loc-search").textContent).toBe(
      "?trace=t-2&turn=a1",
    );
  });
});
