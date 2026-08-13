import { describe, expect, it } from "vitest";
import {
  clearLiveTurnEvents,
  dropRunningAssistantTail,
  removeLiveTurn,
} from "../reconnectLiveTurn";

type T = { id: string; events: string[]; userText: string | null };

describe("reconnectLiveTurn", () => {
  const live: T = { id: "live", events: ["a", "b"], userText: null };
  const queued: T = { id: "queued", events: [], userText: "later" };

  it("clearLiveTurnEvents：只清空 active id，保留队尾其它 turn", () => {
    const next = clearLiveTurnEvents([live, queued], "live");
    expect(next).toEqual([{ id: "live", events: [], userText: null }, queued]);
  });

  it("clearLiveTurnEvents：勿清队尾——id 缺失时原样返回", () => {
    expect(clearLiveTurnEvents([live, queued], null)).toEqual([live, queued]);
    expect(clearLiveTurnEvents([live, queued], "missing")).toEqual([
      live,
      queued,
    ]);
  });

  it("removeLiveTurn：只删 live，不误删其它 turn（禁 slice(0,-1)）", () => {
    expect(removeLiveTurn([live, queued], "live")).toEqual([queued]);
  });

  it("removeLiveTurn：id 缺失时不删队尾", () => {
    expect(removeLiveTurn([live, queued], null)).toEqual([live, queued]);
  });
});

describe("dropRunningAssistantTail", () => {
  const user = { role: "user" as const, status: null };
  const done = { role: "assistant" as const, status: "complete" };
  const running = { role: "assistant" as const, status: "running" };

  it("丢掉末尾 running 助手影子行（该回合由 live 气泡承担）", () => {
    expect(dropRunningAssistantTail([user, done, user, running])).toEqual([
      user,
      done,
      user,
    ]);
  });

  it("末尾不是 running 助手行则原样返回", () => {
    expect(dropRunningAssistantTail([user, done])).toEqual([user, done]);
    expect(dropRunningAssistantTail([user])).toEqual([user]);
    expect(dropRunningAssistantTail([])).toEqual([]);
  });

  it("更早的中断回合是历史事实，不许连坐", () => {
    const interrupted = { role: "assistant" as const, status: "incomplete" };
    expect(dropRunningAssistantTail([interrupted, user, done])).toEqual([
      interrupted,
      user,
      done,
    ]);
  });
});
