import { describe, expect, it } from "vitest";
import { clearLiveTurnEvents, removeLiveTurn } from "../reconnectLiveTurn";

type T = { id: string; events: string[]; userText: string | null };

describe("reconnectLiveTurn", () => {
  const live: T = { id: "live", events: ["a", "b"], userText: null };
  const queued: T = { id: "queued", events: [], userText: "later" };

  it("clearLiveTurnEvents：只清空 active id，保留队尾排队泡", () => {
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

  it("removeLiveTurn：只删 live，不误删排队泡（禁 slice(0,-1)）", () => {
    expect(removeLiveTurn([live, queued], "live")).toEqual([queued]);
  });

  it("removeLiveTurn：id 缺失时不删队尾", () => {
    expect(removeLiveTurn([live, queued], null)).toEqual([live, queued]);
  });
});
